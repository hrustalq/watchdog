// Sends each Delivery in its own job (docs: Actions and delivery, "Deliveries"; ADR 0028).
import { deliver, type DeliverDeps, type ProcessItemDeps, releaseDueDeliveries } from "@watchdog/core";
import { type Db, sql } from "@watchdog/db";
import { fromDrizzle, type PgBoss } from "pg-boss";

export const deliverQueue = "deliver";
const sweepQueue = "deliver-sweep";

/** Queues one job per new Delivery over the Act stage's transaction, so they commit or roll back together. */
export function deliveryEnqueuer(boss: PgBoss): ProcessItemDeps["enqueueDeliveries"] {
  return async (tx, deliveryIds) => {
    await boss.insert(
      deliverQueue,
      deliveryIds.map((deliveryId) => ({ data: { deliveryId } })),
      { db: fromDrizzle(tx, sql) },
    );
  };
}

// A failed send is recorded by `deliver`, which queues its own retry, so these retries are for a job
// that couldn't finish: its worker died, or the database went away. As many as a Delivery has attempts,
// so a run of crashes doesn't strand a row. A request through the egress guard takes 30 seconds and the
// Mailer's timeouts keep a stalled SMTP send to minutes, so a job still active after 15 belongs to a
// worker that died. pg-boss deletes a job left waiting past its retention, so a long outage keeps it
// as long as the Delivery's own 30 days.
const queueOptions = {
  retryLimit: 12,
  retryBackoff: true,
  retryDelay: 30,
  expireInSeconds: 15 * 60,
  retentionSeconds: 30 * 24 * 60 * 60,
};

/** createQueue leaves an existing queue as it was, so an upgraded install needs updateQueue too. */
export async function createDeliveryQueue(boss: PgBoss) {
  await boss.createQueue(deliverQueue, queueOptions);
  await boss.updateQueue(deliverQueue, queueOptions);
}

/**
 * Releases held and grouped Deliveries whose time has come, in one transaction with their jobs, so a
 * later sweep can't queue them twice. `deliver` then checks them against the settings as they are now,
 * and sends what is due to a Destination together.
 */
export async function enqueueDueDeliveries(db: Db, boss: PgBoss) {
  await db.transaction(async (tx) => {
    const due = await releaseDueDeliveries(tx);
    if (due.length > 0) await deliveryEnqueuer(boss)(tx, due.map(({ id }) => id));
  });
}

/** Call before the pipeline starts: queueing a job fails on a queue that doesn't exist. */
export async function startDelivery(
  db: Db,
  boss: PgBoss,
  deps: Pick<DeliverDeps, "senders" | "appUrl" | "emailCap">,
) {
  await createDeliveryQueue(boss);
  await boss.createQueue(sweepQueue);

  const retryDelivery: DeliverDeps["retryDelivery"] = async (tx, deliveryId, at) => {
    await boss.insert(deliverQueue, [{ data: { deliveryId }, startAfter: at }], { db: fromDrizzle(tx, sql) });
  };
  await boss.work<{ deliveryId: string }>(deliverQueue, { localConcurrency: 10 }, async ([job]) => {
    if (job === undefined) return;
    const { deliveryId } = job.data;
    try {
      await deliver(db, deliveryId, { ...deps, retryDelivery });
    } catch (error) {
      console.error(`Sending Delivery ${deliveryId} failed:`, error);
      throw error;
    }
  });

  // pg-boss runs a schedule once a minute however many workers there are. The first sweep doesn't wait
  // for it, so what came due while no worker ran goes at once.
  await boss.work(sweepQueue, () => enqueueDueDeliveries(db, boss));
  await boss.schedule(sweepQueue, "* * * * *");
  await boss.send(sweepQueue);
}
