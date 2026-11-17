import { and, type Db, eq, workspace } from "@watchdog/db";
import { isUuid } from "./uuid.ts";

/** The longest name the screens accept, in characters. */
export const workspaceNameLimit = 100;

/**
 * A Workspace's name as the forms post it: trimmed, 1 to 100 characters, or undefined when it isn't
 * one. Names are unique per owner, which the database holds; this is the check before that.
 */
export function workspaceName(value: unknown) {
  const name = typeof value === "string" ? value.trim() : "";
  return name === "" || name.length > workspaceNameLimit ? undefined : name;
}

/**
 * Whether Postgres refused a write because a unique index already holds that value. Drizzle wraps
 * the driver's error, so the code is on its cause.
 */
function isDuplicate(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "cause" in error &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "code" in error.cause &&
    error.cause.code === "23505"
  );
}

/** A Workspace as the switcher and the Workspaces screen list it. */
export interface WorkspaceSummary {
  id: string;
  name: string;
  createdAt: Date;
}

/**
 * The user's Workspaces, oldest first: the order the switcher lists them in, and the order the active
 * one falls back to when the cookie names none of them.
 */
export async function listWorkspaces(db: Db, ownerId: string): Promise<WorkspaceSummary[]> {
  return db.query.workspace.findMany({
    columns: { id: true, name: true, createdAt: true },
    where: (table) => eq(table.ownerUserId, ownerId),
    orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)],
  });
}

/**
 * Creates a Workspace with the database's defaults for everything else — UTC, 20 alerts an hour, a
 * 60-second burst, 90 and 30 days of retention — and the user as owner. It returns undefined when the
 * owner already has one by that name, which the unique index decides, so two creates of one name
 * can't both land.
 */
export async function createWorkspace(db: Db, ownerId: string, name: string) {
  const [created] = await db
    .insert(workspace)
    .values({ ownerUserId: ownerId, name })
    .onConflictDoNothing()
    .returning({ id: workspace.id, name: workspace.name });
  return created;
}

/** What a rename did: it took the name, the owner already has one by it, or there is no such Workspace. */
export type RenameOutcome = "renamed" | "duplicate" | "missing";

/**
 * Renames one of the owner's Workspaces. The unique index on (owner_user_id, name) is the authority
 * on a duplicate, so a rename that races another into one name is refused like any other.
 */
export async function renameWorkspace(db: Db, ownerId: string, id: string, name: string): Promise<RenameOutcome> {
  try {
    const [renamed] = await db
      .update(workspace)
      .set({ name })
      .where(and(eq(workspace.id, id), eq(workspace.ownerUserId, ownerId)))
      .returning({ id: workspace.id });
    return renamed === undefined ? "missing" : "renamed";
  } catch (error) {
    if (isDuplicate(error)) return "duplicate";
    throw error;
  }
}

/**
 * The Workspace this request reads: the one the cookie names when this owner holds it, otherwise
 * their oldest, created on the first request after their first sign-in. The cookie is a preference,
 * never an authorization: an id another user owns, a stale one and a malformed one all fall back to
 * the oldest, exactly as a missing cookie does.
 *
 * It's created here rather than in a Better Auth hook because those run after the sign-up commits,
 * so a failed hook would leave a user with no Workspace. Here the next request simply tries again.
 */
export async function workspaceFor(db: Db, owner: { id: string; email: string }, activeId?: string) {
  const byId = (id: string) =>
    db.query.workspace.findFirst({
      where: (table) => and(eq(table.ownerUserId, owner.id), eq(table.id, id)),
    });
  const oldest = () =>
    db.query.workspace.findFirst({
      where: (table) => eq(table.ownerUserId, owner.id),
      orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)],
    });

  if (activeId !== undefined && isUuid(activeId)) {
    const chosen = await byId(activeId);
    if (chosen) return chosen;
  }

  const existing = await oldest();
  if (existing) return existing;

  // Concurrent first requests both get here; (owner_user_id, name) lets one insert win.
  const local = owner.email.split("@", 1)[0] ?? "";
  const name = local === "" ? owner.email : local;
  await db
    .insert(workspace)
    .values({ name: name.slice(0, workspaceNameLimit), ownerUserId: owner.id })
    .onConflictDoNothing();
  const created = await oldest();
  if (!created) throw new Error(`No Workspace for user ${owner.id} after creating it`);
  return created;
}
