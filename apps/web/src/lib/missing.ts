import { action, and, classifier, eq, extractorRule, item, workspace, type Db } from "@watchdog/db";
import type { RuleType } from "./rule-draft.ts";
import { isRuleType } from "./rules.ts";
import { isUuid } from "./uuid.ts";

/**
 * Next.js's route for a URL no other route matched. It answers `404` with `app/not-found.tsx`, and a
 * rewrite to it keeps the address the visitor asked for.
 */
export const notFoundPath = "/_not-found";

const itemPath = /^\/items\/([^/]+)$/;
const rulePath = /^\/rules\/([^/]+)\/([^/]+)$/;

/** Whether the path is an Item or a rule detail page: the two that answer not-found for a missing one. */
export const isDetailPath = (pathname: string) => itemPath.test(pathname) || rulePath.test(pathname);

const ruleTables = { classifier, extractor: extractorRule, action };

/**
 * Whether this visitor's Workspace has no Item or rule at this path, so the page would render the
 * not-found UI. Next.js fixes a response's status when it starts streaming, which is before the page
 * runs its own lookup, so the answer has to come from Proxy, ahead of the render.
 *
 * Scoped by `userId` rather than a Workspace id: finding it here must not create one, as
 * `requireWorkspace` does for a new account, and a Workspace has one owner (`owner_user_id` is
 * unique), so the user names the same Workspace the page will read. Another Workspace's id finds
 * nothing, the same as an id that never existed, so the answer says nothing about whether it does.
 */
export function missing(db: Db, userId: string, pathname: string): Promise<boolean> {
  const rule = rulePath.exec(pathname);
  if (rule !== null) {
    const [, type, id] = rule;
    if (!isRuleType(type) || id === undefined || !isUuid(id)) return Promise.resolve(true);
    return absent(db, ruleTables[type], userId, id);
  }
  const id = itemPath.exec(pathname)?.[1];
  if (id === undefined) return Promise.resolve(false);
  return isUuid(id) ? absent(db, item, userId, id) : Promise.resolve(true);
}

/**
 * Looks for a row with this id in a Workspace the user owns. Postgres refuses a malformed uuid with
 * an error rather than matching nothing, so `missing` checks that first.
 */
async function absent(
  db: Db,
  table: typeof item | (typeof ruleTables)[RuleType],
  userId: string,
  id: string,
): Promise<boolean> {
  const [found] = await db
    .select({ id: table.id })
    .from(table)
    .innerJoin(workspace, eq(workspace.id, table.workspaceId))
    .where(and(eq(table.id, id), eq(workspace.ownerUserId, userId)))
    .limit(1);
  return found === undefined;
}
