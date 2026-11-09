// Polls Sources with a Schedule Trigger (docs: Sources and ingestion, "Scheduling"). One tick a
// minute enqueues the Sources that are due, rather than one pg-boss schedule per Source.
import { type Config, nextPollAt, pollSource, type PollSourceDeps } from "@watchdog/core";
import { and, type Db, eq, inArray, lte, scheduleTypes, source } from "@watchdog/db";
import type { PgBoss } from "pg-boss";

const tickQueue = "schedule-tick";
export const pollQueue = "poll-source";

/**
 * Enqueues a poll of every due Source whose type has a Schedule Trigger. A Source already queued or
 * polling is skipped.
 */
export async function enqueueDuePolls(db: Db, boss: PgBoss) {
  const due = await db
    .select({ id: source.id })
    .from(source)
    .where(and(lte(source.nextPollAt, new Date()), inArray(source.type, scheduleTypes)));
  if (due.length === 0) return;
  await boss.insert(
    pollQueue,
    due.map(({ id }) => ({ data: { sourceId: id }, singletonKey: id })),
  );
}

export async function startScheduler(
  db: Db,
  boss: PgBoss,
  mode: Config["mode"],
  deps: PollSourceDeps,
) {
  await boss.createQueue(tickQueue);
  // `exclusive` with a singletonKey per Source: one poll of a Source queued or running at a time.
  // pollSource records fetch failures itself, so a throw is a bug or a lost database connection.
  // A poll takes at most the 30 s fetch timeout plus the capture, so a job still active after two
  // minutes belongs to a worker that died, and expiring it lets the Source be polled again.
  await boss.createQueue(pollQueue, {
    policy: "exclusive",
    retryBackoff: true,
    retryDelay: 30,
    expireInSeconds: 120,
  });

  await boss.work<{ sourceId: string }>(pollQueue, { localConcurrency: 10 }, async ([job]) => {
    if (job === undefined) return;
    const { sourceId } = job.data;
    try {
      // The next poll is set first, so a poll that throws gets pg-boss's retries and then waits for
      // its schedule, rather than being enqueued again by every tick.
      const found = await db.query.source.findFirst({
        where: eq(source.id, sourceId),
        columns: { schedule: true },
      });
      // Only Schedule types have a schedule, and only they come due.
      const schedule = found?.schedule ?? null;
      if (schedule === null) return;
      await db
        .update(source)
        .set({ nextPollAt: nextPollAt(schedule, mode, new Date()) })
        .where(eq(source.id, sourceId));
      await pollSource(db, sourceId, { ...deps, mode });
    } catch (error) {
      console.error(`Polling Source ${sourceId} failed:`, error);
      throw error;
    }
  });
  await boss.work(tickQueue, () => enqueueDuePolls(db, boss));

  // pg-boss runs a schedule once a minute however many workers there are. The first tick doesn't
  // wait for it, so Sources that came due while no worker ran are polled at once.
  await boss.schedule(tickQueue, "* * * * *");
  await boss.send(tickQueue);
}
