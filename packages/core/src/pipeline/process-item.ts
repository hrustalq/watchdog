// What happens to an Item after capture (docs: Processing pipeline, "Stages"). The worker's
// process-item queue calls this once per captured Item.
import { type Db, eq, item, source } from "@watchdog/db";
import { runDeterministicClassifiers } from "./classify.ts";
import { runDeterministicExtractorRules } from "./extract.ts";

export interface ProcessItemDeps {
  now?: () => Date;
}

/**
 * Runs an Item through the pipeline and sets `processed_at`. It all commits together, so a job that
 * dies midway leaves nothing behind, and the row lock and `processed_at` make a repeated run do
 * nothing. An Item that's gone, deleted while its job waited, is nothing to process.
 */
export async function processItem(db: Db, itemId: string, deps: ProcessItemDeps): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ item, sourceType: source.type })
      .from(item)
      .innerJoin(source, eq(item.sourceId, source.id))
      .where(eq(item.id, itemId))
      .for("update", { of: item });
    if (row?.item.processedAt !== null) return;

    const target = { ...row.item, sourceType: row.sourceType };
    await runDeterministicClassifiers(tx, itemId, target);
    await runDeterministicExtractorRules(tx, itemId, target);

    await tx
      .update(item)
      .set({ processedAt: deps.now?.() ?? new Date() })
      .where(eq(item.id, itemId));
  });
}
