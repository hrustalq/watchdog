import {
  and,
  type classifier,
  type Db,
  eq,
  type extractorRule,
  item,
  itemLog,
  lte,
  type Tx,
} from "@watchdog/db";

type Reader = Pick<Db | Tx, "select">;

/**
 * A Workspace's enabled rules of one kind for an Item, oldest first. A rule saved after the Item was
 * captured doesn't apply to it, even when the job ran late (docs: Processing pipeline, "When rules
 * change"). That's compared in SQL, because a JS Date would cut captured_at to the millisecond.
 */
export function rulesFor(
  db: Reader,
  table: typeof classifier | typeof extractorRule,
  itemId: string,
  kind: "deterministic" | "agent",
) {
  return db
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
    .where(and(eq(table.kind, kind), eq(table.enabled, true)))
    .orderBy(table.createdAt, table.id);
}

/** The ids of rules with a row in the Item's Log, which a retried job doesn't run or note again. */
export async function rulesInLog(
  db: Reader,
  itemId: string,
  stage: "classify" | "extract",
  idKey: "classifierId" | "extractorRuleId",
) {
  const rows = await db
    .select({ data: itemLog.data })
    .from(itemLog)
    .where(and(eq(itemLog.itemId, itemId), eq(itemLog.stage, stage)));
  return new Set(rows.map(({ data }) => (data as Record<string, unknown>)[idKey]));
}
