// Sends each Delivery in its own job (docs: Actions and delivery, "Deliveries"; ADR 0028).
import {
  deliver,
  type DeliverDeps,
  type DigestDeps,
  dueDigests,
  type EmailCap,
  type ProcessItemDeps,
  purgeExpiredLinkCodes,
  purgeSentMessages,
  releaseDueDeliveries,
  releaseDueSourceAlerts,
  sendDigest,
  sendSourceAlert,
  type SourceAlertDeps,
} from "@watchdog/core";
import { type Db, type SQL, sql, workspace } from "@watchdog/db";
import { fromDrizzle, type JobResult, type PgBoss } from "pg-boss";

export const deliverQueue = "deliver";
const sweepQueue = "deliver-sweep";
const capNoticeQueue = "email-cap-notice";
export const digestQueue = "send-digest";
export const sourceAlertQueue = "source-alert";

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

// sendDigest records a failed send itself, so a throw is a lost database connection. A retry after the
// firing was claimed finds it no longer due, and one before claims it again, so a few are enough.
const digestQueueOptions = {
  retryLimit: 3,
  retryBackoff: true,
  retryDelay: 30,
  expireInSeconds: 15 * 60,
};

/** createQueue leaves an existing queue as it was, so an upgraded install needs updateQueue too. */
export async function createDeliveryQueue(boss: PgBoss) {
  await boss.createQueue(deliverQueue, queueOptions);
  await boss.updateQueue(deliverQueue, queueOptions);
}

/** The notice's job commits with the hold it's about, and pg-boss retries it, so it's neither lost nor repeated. */
export function capNoticeQueuer(boss: PgBoss): EmailCap {
  return {
    queueNotice: async (tx, workspaceId) => {
      await boss.insert(capNoticeQueue, [{ data: { workspaceId } }], { db: fromDrizzle(tx, sql) });
    },
  };
}

export async function createCapNoticeQueue(boss: PgBoss) {
  await boss.createQueue(capNoticeQueue, queueOptions);
  await boss.updateQueue(capNoticeQueue, queueOptions);
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

/**
 * Queues a job for every Source Health alert whose time has come: a new one, which is written held and
 * due by whatever changed the Source's Health, and one a setting held.
 */
export async function enqueueDueSourceAlerts(db: Db, boss: PgBoss) {
  await db.transaction(async (tx) => {
    const due = await releaseDueSourceAlerts(tx);
    if (due.length === 0) return;
    await boss.insert(
      sourceAlertQueue,
      due.map(({ id }) => ({ data: { alertId: id } })),
      { db: fromDrizzle(tx, sql) },
    );
  });
}

/** Queues a send of every Digest whose schedule has come. One is queued or sending at a time, by its id. */
export async function enqueueDueDigests(db: Db, boss: PgBoss) {
  const due = await dueDigests(db, new Date());
  if (due.length === 0) return;
  await boss.insert(
    digestQueue,
    due.map((actionId) => ({ data: { actionId }, singletonKey: actionId })),
  );
}

/** Rows one delete takes, so the first sweep over a year of Items never holds the sweep for a backlog. */
export const purgeBatchSize = 5_000;

export interface PurgedRows {
  items: number;
  logs: number;
  deliveries: number;
}

async function deletedRows(db: Db, statement: SQL) {
  const result = await db.execute(statement);
  return result.rowCount ?? 0;
}

/**
 * Takes one batch at a time: Postgres has no LIMIT on DELETE, so each statement names the rows it means by
 * their ctid, and the caller asks again while a batch came back full.
 */
async function purgeInBatches(db: Db, deleteBatch: (limit: number) => Promise<number>) {
  let purged = 0;
  for (;;) {
    const deleted = await deleteBatch(purgeBatchSize);
    purged += deleted;
    if (deleted < purgeBatchSize) return purged;
  }
}

/**
 * Deletes what each Workspace's retention windows no longer cover (docs: Processing pipeline,
 * "Retention"): Items captured before its Items window, with the Log, Deliveries and Ratings that cascade
 * from them; the Log rows older than its Log window; and the Deliveries older than that window, reached
 * through their Destination. A null window is unlimited, so nothing of that kind goes.
 *
 * Each batch is its own statement, so a year of Items goes without holding the sweep, and the delivery
 * queue keeps its jobs: a Delivery purged before its job runs is one `deliver` finds and returns on.
 */
export async function purgeExpiredRows(db: Db): Promise<PurgedRows> {
  const windows = await db
    .select({
      id: workspace.id,
      itemsDays: workspace.itemsRetentionDays,
      logDays: workspace.logRetentionDays,
    })
    .from(workspace);
  const purged: PurgedRows = { items: 0, logs: 0, deliveries: 0 };
  for (const window of windows) {
    // A const apiece, so the null check holds inside the closures below.
    const itemsDays = window.itemsDays;
    const logDays = window.logDays;
    if (itemsDays !== null) {
      purged.items += await purgeInBatches(db, (limit) =>
        deletedRows(
          db,
          sql`
            delete from item where ctid in (
              select ctid from item
              where workspace_id = ${window.id} and captured_at < now() - make_interval(days => ${itemsDays})
              limit ${limit}
            )
          `,
        ),
      );
    }
    if (logDays === null) continue;
    purged.logs += await purgeInBatches(db, (limit) =>
      deletedRows(
        db,
        sql`
          delete from item_log where ctid in (
            select l.ctid from item_log l join item i on i.id = l.item_id
            where i.workspace_id = ${window.id} and l.at < now() - make_interval(days => ${logDays})
            limit ${limit}
          )
        `,
      ),
    );
    purged.deliveries += await purgeInBatches(db, (limit) =>
      deletedRows(
        db,
        sql`
          delete from delivery where ctid in (
            select d.ctid from delivery d join destination dest on dest.id = d.destination_id
            where dest.workspace_id = ${window.id} and d.created_at < now() - make_interval(days => ${logDays})
            limit ${limit}
          )
        `,
      ),
    );
  }
  if (purged.items + purged.logs + purged.deliveries > 0) {
    console.log(
      `Retention purged ${String(purged.items)} Items, ${String(purged.logs)} Log rows and ` +
        `${String(purged.deliveries)} Deliveries`,
    );
  }
  return purged;
}

/** Call before the pipeline starts: queueing a job fails on a queue that doesn't exist. */
export async function startDelivery(
  db: Db,
  boss: PgBoss,
  {
    sendCapNotice,
    ...deps
  }: Pick<DeliverDeps, "senders" | "appUrl"> &
    Pick<SourceAlertDeps, "senders"> &
    Pick<DigestDeps, "secret"> & {
    /** Only hosted has the email cap, and so a notice about it. */
    sendCapNotice?: (workspaceId: string) => Promise<void>;
  },
) {
  await createDeliveryQueue(boss);
  await boss.createQueue(sweepQueue);

  const retryDelivery: DeliverDeps["retryDelivery"] = async (tx, deliveryId, at) => {
    await boss.insert(deliverQueue, [{ data: { deliveryId }, startAfter: at }], { db: fromDrizzle(tx, sql) });
  };
  // A Delivery waiting for its chat's turn goes back in the queue for that turn, a second or so away. Half
  // a second is the fastest poll pg-boss allows, and at its default of two the turn behind one comes a
  // second or two late.
  //
  // A poll takes ten jobs at a time, so one job at a time walked a burst of 50 in five polls: the Delivery
  // queued behind them waited the whole walk, which a loaded runner turned into eight seconds. A full batch
  // is fetched again at once instead, so a backlog drains at the database's pace rather than a batch a poll.
  // Two workers keep a batch whose send stalls, as a slow mail does, from stopping the queue behind it, and
  // each job is settled on its own, so a failure still retries the one job it belongs to.
  await boss.work<{ deliveryId: string }>(
    deliverQueue,
    {
      batchSize: 10,
      localConcurrency: 2,
      burstWhenBatchFull: true,
      perJobResults: true,
      pollingIntervalSeconds: 0.5,
    },
    async (jobs) =>
      Promise.all(
        jobs.map(async (job): Promise<JobResult> => {
          const { deliveryId } = job.data;
          try {
            await deliver(db, deliveryId, { ...deps, retryDelivery, ...(sendCapNotice && { emailCap: capNoticeQueuer(boss) }) });
            return { id: job.id, status: "completed" };
          } catch (error) {
            console.error(`Sending Delivery ${deliveryId} failed:`, error);
            return { id: job.id, status: "failed", output: error };
          }
        }),
      ),
  );

  // A Source Health alert is sent like a Delivery, so its queue has the same options.
  await boss.createQueue(sourceAlertQueue, queueOptions);
  await boss.updateQueue(sourceAlertQueue, queueOptions);
  const retrySourceAlert: SourceAlertDeps["retrySourceAlert"] = async (tx, alertId, at) => {
    await boss.insert(sourceAlertQueue, [{ data: { alertId }, startAfter: at }], { db: fromDrizzle(tx, sql) });
  };
  await boss.work<{ alertId: string }>(sourceAlertQueue, { localConcurrency: 5 }, async ([job]) => {
    if (job === undefined) return;
    const { alertId } = job.data;
    try {
      await sendSourceAlert(db, alertId, { ...deps, retrySourceAlert, ...(sendCapNotice && { emailCap: capNoticeQueuer(boss) }) });
    } catch (error) {
      console.error(`Sending Source Health alert ${alertId} failed:`, error);
      throw error;
    }
  });

  // `exclusive` with the Digest's id as the singletonKey, as a Source's poll is.
  // A policy is fixed when the queue is made, and updateQueue refuses one.
  await boss.createQueue(digestQueue, { ...digestQueueOptions, policy: "exclusive" });
  await boss.updateQueue(digestQueue, digestQueueOptions);
  await boss.work<{ actionId: string }>(digestQueue, { localConcurrency: 5 }, async ([job]) => {
    if (job === undefined) return;
    const { actionId } = job.data;
    try {
      await sendDigest(db, actionId, { ...deps, ...(sendCapNotice && { emailCap: capNoticeQueuer(boss) }) });
    } catch (error) {
      console.error(`Sending Digest ${actionId} failed:`, error);
      throw error;
    }
  });

  if (sendCapNotice) {
    await createCapNoticeQueue(boss);
    await boss.work<{ workspaceId: string }>(capNoticeQueue, async ([job]) => {
      if (job === undefined) return;
      try {
        await sendCapNotice(job.data.workspaceId);
      } catch (error) {
        console.error(`Sending the email cap notice for Workspace ${job.data.workspaceId} failed:`, error);
        throw error;
      }
    });
  }

  // pg-boss runs a schedule once a minute however many workers there are. The first sweep doesn't wait
  // for it, so what came due while no worker ran goes at once.
  await boss.work(sweepQueue, async () => {
    await enqueueDueDeliveries(db, boss);
    await enqueueDueSourceAlerts(db, boss);
    await enqueueDueDigests(db, boss);
    await purgeExpiredRows(db);
    await purgeSentMessages(db);
    await purgeExpiredLinkCodes(db);
  });
  await boss.schedule(sweepQueue, "* * * * *");
  await boss.send(sweepQueue);
}
