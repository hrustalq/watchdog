// Telegram user session logins, revokes and runners, self-hosted only (ADR 0014, ADR 0032).
import { telegramLoginQueue, telegramRevokeQueue } from "@watchdog/core";
import type { PgBoss } from "pg-boss";

type Run = (id: string, signal: AbortSignal) => Promise<void>;

export const sessionQueue = "telegram-session";
const sessionTickQueue = "telegram-session-tick";
// A job can't stay active past its expiry, so a turn ends at this mark and the next tick starts
// another, which catches up on the minute between them from the chats' history.
const turnSeconds = 60 * 60;
// `exclusive` with a singletonKey per session: one turn of a session queued or running. The
// heartbeat frees it within a minute or two when its worker dies.
const runnerQueue = { policy: "exclusive", heartbeatSeconds: 30, expireInSeconds: 2 * turnSeconds } as const;

// One job holds a login for at most its 5 minutes; past 6 the job is a dead worker's. Never
// retried, because a retry would make Telegram send a second code.
const loginQueue = { retryLimit: 0, expireInSeconds: 6 * 60 };
// A revoke that couldn't reach Telegram keeps the session, so it's tried again.
const revokeQueue = { retryLimit: 10, retryBackoff: true, retryDelay: 30, expireInSeconds: 5 * 60 };

/**
 * Runs logins, 5 at a time on this worker, revokes, and one runner per live session, which a tick
 * each minute starts. Gives back what ends the running logins and runners, because pg-boss's stop
 * only aborts a job's signal after its grace period.
 */
export async function startTelegramSessions(
  boss: PgBoss,
  run: {
    login: Run;
    revoke: (id: string) => Promise<void>;
    /** One turn of a session's runner, until the signal ends or `until`, when the turn's job expires. */
    session: (id: string, signal: AbortSignal, until: Date) => Promise<void>;
    /** The sessions a turn may start for: not revoked, and not waiting out a FLOOD_WAIT. */
    live: () => Promise<{ id: string }[]>;
  },
) {
  const stopping = new AbortController();
  await boss.createQueue(telegramLoginQueue, loginQueue);
  await boss.updateQueue(telegramLoginQueue, loginQueue);
  await boss.createQueue(telegramRevokeQueue, revokeQueue);
  await boss.updateQueue(telegramRevokeQueue, revokeQueue);
  await boss.work<{ id: string }>(telegramLoginQueue, { localConcurrency: 5 }, async ([job]) => {
    if (job !== undefined) await run.login(job.data.id, AbortSignal.any([job.signal, stopping.signal]));
  });
  await boss.work<{ id: string }>(telegramRevokeQueue, async ([job]) => {
    if (job !== undefined) await run.revoke(job.data.id);
  });
  await boss.createQueue(sessionQueue, runnerQueue);
  // Its policy can't change after creation, so only the rest is updated.
  const { policy: _, ...runnerOptions } = runnerQueue;
  await boss.updateQueue(sessionQueue, runnerOptions);
  // Each turn holds its connection for the hour, so a worker runs this many sessions at once.
  await boss.work<{ id: string }>(sessionQueue, { localConcurrency: 20 }, async ([job]) => {
    if (job === undefined) return;
    const until = new Date(Date.now() + turnSeconds * 1000);
    await run.session(job.data.id, AbortSignal.any([job.signal, stopping.signal, AbortSignal.timeout(turnSeconds * 1000)]), until);
  });
  await boss.createQueue(sessionTickQueue);
  await boss.work(sessionTickQueue, async () => {
    const sessions = await run.live();
    if (sessions.length > 0) await boss.insert(sessionQueue, sessions.map(({ id }) => ({ data: { id }, singletonKey: id })));
  });
  // pg-boss runs a schedule once a minute however many workers there are. The first tick doesn't wait for it.
  await boss.schedule(sessionTickQueue, "* * * * *");
  await boss.send(sessionTickQueue);
  return () => {
    stopping.abort();
  };
}
