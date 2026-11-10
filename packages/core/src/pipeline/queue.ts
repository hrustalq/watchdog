// The process-item queue, which the worker runs and both the worker and web send to (docs: Processing
// pipeline, "Stages"; System overview and runtime).
import { sql } from "@watchdog/db";
import { fromDrizzle, type PgBoss } from "pg-boss";
import type { CaptureDeps } from "./capture.ts";

export const processItemQueue = "process-item";

/** Queues one job per Item over the capture's transaction, so they commit or roll back together. */
export function itemEnqueuer(boss: PgBoss): CaptureDeps["enqueueItems"] {
  return async (tx, itemIds) => {
    await boss.insert(
      processItemQueue,
      itemIds.map((itemId) => ({ data: { itemId } })),
      { db: fromDrizzle(tx, sql) },
    );
  };
}
