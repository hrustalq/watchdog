import { workspace, type Db } from "@watchdog/db";

/**
 * The user's Workspace, created on the first request after their first sign-in. It's created here
 * rather than in a Better Auth hook because those run after the sign-up commits, so a failed hook
 * would leave a user with no Workspace. Here the next request simply tries again.
 */
export async function workspaceFor(db: Db, owner: { id: string; email: string }) {
  const find = () =>
    db.query.workspace.findFirst({ where: (table, { eq }) => eq(table.ownerUserId, owner.id) });

  const existing = await find();
  if (existing) return existing;

  // Concurrent first requests both get here; the unique owner_user_id lets one insert win.
  const name = owner.email.split("@", 1)[0] ?? owner.email;
  await db.insert(workspace).values({ name, ownerUserId: owner.id }).onConflictDoNothing();
  const created = await find();
  if (!created) throw new Error(`No Workspace for user ${owner.id} after creating it`);
  return created;
}
