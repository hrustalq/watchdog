// What happens to an Item after capture (docs: Processing pipeline, "Stages"). The worker's
// process-item queue calls this once per captured Item.
import { type Db, eq, item, source, type Tx } from "@watchdog/db";
import { type AgentDeps, runAgentClassifiers, runDeterministicClassifiers } from "./classify.ts";
import { runDeterministicExtractorRules } from "./extract.ts";
import { runExtractAndRate } from "./rate.ts";

export interface ProcessItemDeps {
  now?: () => Date;
  agent: AgentDeps;
  /** No retry follows this run, so a failed call still finishes the Item, which stays unrated. */
  lastAttempt?: boolean;
}

/** Locks the Item's row. Undefined when it's finished, or gone: deleted while its job waited. */
async function lockUnfinished(tx: Tx, itemId: string) {
  const [row] = await tx
    .select({ item, sourceType: source.type, sourceName: source.name })
    .from(item)
    .innerJoin(source, eq(item.sourceId, source.id))
    .where(eq(item.id, itemId))
    .for("update", { of: item });
  if (row?.item.processedAt !== null) return undefined;
  return { ...row.item, sourceType: row.sourceType, sourceName: row.sourceName };
}

/**
 * Runs an Item through the pipeline and sets `processed_at`, which makes a repeated run do nothing.
 * No transaction spans the model call, so it can't hold a connection and the Item's row for minutes,
 * and each stage instead leaves what a retry needs to pick up where it stopped. A failed call throws
 * once the deterministic rules have run, so the job retries (docs: Processing pipeline, "Failures").
 * The extract-and-rate answer commits with `processed_at`, which ends the pipeline for now.
 */
export async function processItem(db: Db, itemId: string, deps: ProcessItemDeps): Promise<void> {
  const now = deps.now ?? (() => new Date());

  const target = await db.transaction(async (tx) => {
    const locked = await lockUnfinished(tx, itemId);
    // A Correction decides the Item's Categories from then on.
    if (locked?.categoriesCorrectedAt === null) await runDeterministicClassifiers(tx, itemId, locked);
    return locked;
  });
  if (target === undefined) return;

  const classifyFailure =
    target.classifiedAt === null && target.categoriesCorrectedAt === null
      ? await runAgentClassifiers(db, target, deps.agent, now)
      : undefined;

  const unfinished = await db.transaction(async (tx) => {
    const locked = await lockUnfinished(tx, itemId);
    if (locked === undefined) return undefined;
    await runDeterministicExtractorRules(tx, itemId, locked);
    return locked;
  });
  if (unfinished === undefined) return;

  const finishOnLastAttempt = async () => {
    if (deps.lastAttempt === true) await db.update(item).set({ processedAt: now() }).where(eq(item.id, itemId));
  };

  // The extract-and-rate call waits until classify succeeds (docs: Processing pipeline, "Failures").
  if (classifyFailure !== undefined) {
    await finishOnLastAttempt();
    throw new Error(`The classify call failed: ${classifyFailure.message}`);
  }

  const rateFailure = await runExtractAndRate(db, unfinished, deps.agent, now);
  if (rateFailure !== undefined) {
    await finishOnLastAttempt();
    throw new Error(`The extract-and-rate call failed: ${rateFailure.message}`);
  }
}
