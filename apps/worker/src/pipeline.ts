// Runs each captured Item through the pipeline in its own job (docs: Processing pipeline, "Stages").
import { processItem, type ProcessItemDeps, processItemQueue } from "@watchdog/core";
import type { Db } from "@watchdog/db";
import type { PgBoss } from "pg-boss";
import { deliveryEnqueuer } from "./delivery.ts";

// Retries and concurrency: docs, Agent and LLM integration, "Limits". A job makes up to two calls of
// two attempts at 120 seconds each, so one still active after 10 minutes belongs to a worker that
// died, and expiring it retries the Item. pg-boss deletes a job left waiting past its retention, 14
// days by default, which an Item outlives, so a long outage keeps the job for the Items' own 90 days.
const queueOptions = {
  retryLimit: 3,
  retryBackoff: true,
  retryDelay: 30,
  expireInSeconds: 600,
  retentionSeconds: 90 * 24 * 60 * 60,
};

/** createQueue leaves an existing queue as it was, so an upgraded install needs updateQueue too. */
export async function createPipelineQueue(boss: PgBoss) {
  await boss.createQueue(processItemQueue, queueOptions);
  await boss.updateQueue(processItemQueue, queueOptions);
}

/** Call before anything can capture: queueing a job fails on a queue that doesn't exist. */
export async function startPipeline(db: Db, boss: PgBoss, agent: ProcessItemDeps["agent"]) {
  await createPipelineQueue(boss);
  const enqueueDeliveries = deliveryEnqueuer(boss);

  // Naming the first type argument stops inference, so the options' type has to be named too.
  await boss.work<{ itemId: string }, unknown, { localConcurrency: 4; includeMetadata: true }>(
    processItemQueue,
    { localConcurrency: 4, includeMetadata: true },
    async ([job]) => {
      if (job === undefined) return;
      const { itemId } = job.data;
      try {
        await processItem(db, itemId, { agent, enqueueDeliveries, lastAttempt: job.retryCount >= job.retryLimit });
      } catch (error) {
        console.error(`Processing Item ${itemId} failed:`, error);
        throw error;
      }
    },
  );
}
