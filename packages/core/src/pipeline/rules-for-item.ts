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

/**
 * A stage's Log writer for a job that may be a retry, which runs the rules again: a sentence already
 * in the Item's Log isn't written twice.
 */
export async function logOnce(
  db: Pick<Db | Tx, "select" | "insert">,
  itemId: string,
  stage: "classify" | "extract",
) {
  const rows = await db
    .select({ message: itemLog.message })
    .from(itemLog)
    .where(and(eq(itemLog.itemId, itemId), eq(itemLog.stage, stage)));
  const written = new Set(rows.map((row) => row.message));
  return async (message: string, data: Record<string, unknown>) => {
    if (!written.has(message)) await db.insert(itemLog).values({ itemId, stage, message, data });
  };
}
