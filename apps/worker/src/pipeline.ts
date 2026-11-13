// Runs each captured Item through the pipeline in its own job (docs: Processing pipeline, "Stages";
// Agent and LLM integration, "Limits").
import { agentItemQueue, processItem, type ProcessItemDeps, processItemQueue } from "@watchdog/core";
import type { Db } from "@watchdog/db";
import type { JobWithMetadata, PgBoss } from "pg-boss";
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

// Four Agent jobs for the whole worker, two of them per Workspace. A model that never answers then
// costs two of the four, and another Workspace's Items keep moving (GitHub issue #99). The limit is
// `localGroupConcurrency`: pg-boss's global `groupConcurrency` counts a group's active jobs at claim
// time, so four pollers claiming at once each see none and a group reached four; the local count
// restores the excess before its handler starts, which held a group to two in the measurement.
const agentLimits = { localConcurrency: 4, localGroupConcurrency: 2 };

// A separate pool, so an Item that can't reach the Agent never waits for one that can.
const plainLimits = { localConcurrency: 2 };

/** createQueue leaves an existing queue as it was, so an upgraded install needs updateQueue too. */
export async function createPipelineQueue(boss: PgBoss) {
  for (const name of [processItemQueue, agentItemQueue]) {
    await boss.createQueue(name, queueOptions);
    await boss.updateQueue(name, queueOptions);
  }
}

/** Call before anything can capture: queueing a job fails on a queue that doesn't exist. */
export async function startPipeline(db: Db, boss: PgBoss, agent: ProcessItemDeps["agent"]) {
  await createPipelineQueue(boss);
  const deps: ProcessItemDeps = { agent, enqueueDeliveries: deliveryEnqueuer(boss) };

  const work = async ([job]: JobWithMetadata<{ itemId: string }>[]) => {
    if (job === undefined) return;
    const { itemId } = job.data;
    try {
      await processItem(db, itemId, { ...deps, lastAttempt: job.retryCount >= job.retryLimit });
    } catch (error) {
      console.error(`Processing Item ${itemId} failed:`, error);
      throw error;
    }
  };

  // Naming the first type argument stops inference, so the options' type has to be named too.
  await boss.work<{ itemId: string }, unknown, typeof agentLimits & { includeMetadata: true }>(
    agentItemQueue,
    { ...agentLimits, includeMetadata: true },
    work,
  );
  await boss.work<{ itemId: string }, unknown, typeof plainLimits & { includeMetadata: true }>(
    processItemQueue,
    { ...plainLimits, includeMetadata: true },
    work,
  );
}
