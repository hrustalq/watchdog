import { and, type classifier, eq, type extractorRule, item, lte, type Tx } from "@watchdog/db";

/**
 * A Workspace's enabled deterministic rules for an Item, oldest first. A rule saved after the Item
 * was captured doesn't apply to it, even when the job ran late (docs: Processing pipeline, "When
 * rules change"). That's compared in SQL, because a JS Date would cut captured_at to the millisecond.
 */
export function deterministicRulesFor(
  tx: Tx,
  table: typeof classifier | typeof extractorRule,
  itemId: string,
) {
  return tx
    .select({ id: table.id, name: table.name, definition: table.definition })
    .from(table)
    .innerJoin(
      item,
      and(
        eq(item.id, itemId),
        eq(item.workspaceId, table.workspaceId),
        lte(table.updatedAt, item.capturedAt),
      ),
    )
    .where(and(eq(table.kind, "deterministic"), eq(table.enabled, true)))
    .orderBy(table.createdAt, table.id);
}
