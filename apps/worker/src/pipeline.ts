// Runs each captured Item through the pipeline in its own job (docs: Processing pipeline, "Stages").
import { type PollSourceDeps, processItem } from "@watchdog/core";
import { type Db, sql } from "@watchdog/db";
import { fromDrizzle, type PgBoss } from "pg-boss";

export const processItemQueue = "process-item";

/** Queues one job per Item over the capture's transaction, so they commit or roll back together. */
export function itemEnqueuer(boss: PgBoss): PollSourceDeps["enqueueItems"] {
  return async (tx, itemIds) => {
    await boss.insert(
      processItemQueue,
      itemIds.map((itemId) => ({ data: { itemId } })),
      { db: fromDrizzle(tx, sql) },
    );
  };
}

/** Call before anything can capture: queueing a job fails on a queue that doesn't exist. */
export async function startPipeline(db: Db, boss: PgBoss) {
  // Retries and concurrency: docs, Agent and LLM integration, "Limits". Deterministic stages take
  // far less than two minutes, so a job still active after that belongs to a worker that died, and
  // expiring it retries the Item. pg-boss deletes a job left waiting past its retention, 14 days by
  // default, which an Item outlives, so a long outage keeps the job for the Items' own 90 days.
  await boss.createQueue(processItemQueue, {
    retryLimit: 3,
    retryBackoff: true,
    retryDelay: 30,
    expireInSeconds: 120,
    retentionSeconds: 90 * 24 * 60 * 60,
  });

  await boss.work<{ itemId: string }>(processItemQueue, { localConcurrency: 4 }, async ([job]) => {
    if (job === undefined) return;
    const { itemId } = job.data;
    try {
      await processItem(db, itemId, {});
    } catch (error) {
      console.error(`Processing Item ${itemId} failed:`, error);
      throw error;
    }
  });
}
