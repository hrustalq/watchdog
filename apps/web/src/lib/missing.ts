import { action, and, classifier, eq, extractorRule, item, workspace, type Db } from "@watchdog/db";
import type { RuleType } from "./rule-draft.ts";
import { isRuleType } from "./rules.ts";
import { isUuid } from "./uuid.ts";

/**
 * Next.js's route for a URL no other route matched. It answers `404` with `app/not-found.tsx`, and a
 * rewrite to it keeps the address the visitor asked for.
 */
export const notFoundPath = "/_not-found";

/**
 * What a rewrite to `not-found.tsx` carries to say it answered for a missing Item: the rewrite
 * changes the address, so the page can't tell from the path what it is explaining.
 */
export const itemMissHeader = "x-watchdog-item-miss";

const itemPath = /^\/items\/([^/]+)$/;
const rulePath = /^\/rules\/([^/]+)\/([^/]+)$/;

/** Whether the path is an Item's page, the one whose miss explains why an Item is gone. */
export const isItemPath = (pathname: string) => itemPath.test(pathname);

/** Whether the path is an Item or a rule detail page: the two that answer not-found for a missing one. */
export const isDetailPath = (pathname: string) => isItemPath(pathname) || rulePath.test(pathname);

const ruleTables = { classifier, extractor: extractorRule, action };

/**
 * Whether this visitor's Workspace has no Item or rule at this path, so the page would render the
 * not-found UI. Next.js fixes a response's status when it starts streaming, which is before the page
 * runs its own lookup, so its 404 has to come from Proxy, ahead of the render.
 *
 * It reads the Workspace the page will read: the id the `active_workspace` cookie names when this
 * owner holds it, otherwise their oldest. Scoping by owner alone would find a sibling Workspace's
 * Item and let the page answer 404 with status 200, which is the soft 404 this exists to prevent.
 * Another owner's Workspace finds nothing, the same as an id that never existed, so the answer says
 * nothing about whether it does.
 */
export function missing(db: Db, userId: string, pathname: string, activeId?: string): Promise<boolean> {
  const rule = rulePath.exec(pathname);
  if (rule !== null) {
    const [, type, id] = rule;
    if (!isRuleType(type) || id === undefined || !isUuid(id)) return Promise.resolve(true);
    return absent(db, ruleTables[type], userId, id, activeId);
  }
  const id = itemPath.exec(pathname)?.[1];
  if (id === undefined) return Promise.resolve(false);
  return isUuid(id) ? absent(db, item, userId, id, activeId) : Promise.resolve(true);
}

/**
 * Looks for a row with this id in the Workspace the request reads. Postgres refuses a malformed uuid
 * with an error rather than matching nothing, so `missing` checks that first.
 */
async function absent(
  db: Db,
  table: typeof item | (typeof ruleTables)[RuleType],
  userId: string,
  id: string,
  activeId: string | undefined,
): Promise<boolean> {
  const workspaceId = await readingWorkspace(db, userId, activeId);
  // An account with no Workspace has none of these rows, and its first request creates one, so the
  // page would find nothing to show either.
  if (workspaceId === undefined) return true;
  const [found] = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, id), eq(table.workspaceId, workspaceId)))
    .limit(1);
  return found === undefined;
}

/**
 * The Workspace the page will read, or undefined when the account owns none yet: the id the
 * `active_workspace` cookie names when this owner holds it, otherwise the oldest. It mirrors
 * `workspaceFor` without its create, because answering a miss must not make a Workspace for a new
 * account.
 */
async function readingWorkspace(db: Db, userId: string, activeId: string | undefined) {
  if (activeId !== undefined && isUuid(activeId)) {
    const [chosen] = await db
      .select({ id: workspace.id })
      .from(workspace)
      .where(and(eq(workspace.id, activeId), eq(workspace.ownerUserId, userId)))
      .limit(1);
    if (chosen !== undefined) return chosen.id;
  }
  const [oldest] = await db
    .select({ id: workspace.id })
    .from(workspace)
    .where(eq(workspace.ownerUserId, userId))
    .orderBy(workspace.createdAt, workspace.id)
    .limit(1);
  return oldest?.id;
}
