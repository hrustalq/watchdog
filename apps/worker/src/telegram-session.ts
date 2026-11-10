// Telegram user session logins and revokes, self-hosted only (ADR 0014, ADR 0032).
import { telegramLoginQueue, telegramRevokeQueue } from "@watchdog/core";
import type { PgBoss } from "pg-boss";

type Run = (id: string, signal: AbortSignal) => Promise<void>;

// One job holds a login for at most its 5 minutes; past 6 the job is a dead worker's. Never
// retried, because a retry would make Telegram send a second code.
const loginQueue = { retryLimit: 0, expireInSeconds: 6 * 60 };
// A revoke that couldn't reach Telegram keeps the session, so it's tried again.
const revokeQueue = { retryLimit: 10, retryBackoff: true, retryDelay: 30, expireInSeconds: 5 * 60 };

/**
 * Runs logins, 5 at a time on this worker, and revokes. Gives back what ends the running logins,
 * because pg-boss's stop only aborts a job's signal after its grace period.
 */
export async function startTelegramSessions(boss: PgBoss, run: { login: Run; revoke: (id: string) => Promise<void> }) {
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
  return () => {
    stopping.abort();
  };
}
