// Keeps one Telegram bot loop running across workers (ADR 0029): a single job, which a second worker
// finds taken, because Telegram lets one getUpdates consumer read a bot's updates.
import type { PgBoss } from "pg-boss";

export const botQueue = "telegram-bot";

// A job can't stay active past its expiry, so the loop ends at this mark and the next tick starts it again.
// Telegram keeps updates for 24 hours, so the minute between them loses none.
const turnSeconds = 60 * 60;

/**
 * Starts the loop, and gives back what ends it. pg-boss's stop only aborts a job's signal after its
 * 30-second grace period, so the worker calls this first and the job finishes normally.
 */
export async function startTelegramBot(boss: PgBoss, run: (signal: AbortSignal) => Promise<void>) {
  const stopping = new AbortController();
  // `exclusive`: one job queued or running. The heartbeat frees it within a minute or two when its worker dies.
  await boss.createQueue(botQueue, { policy: "exclusive", heartbeatSeconds: 30, expireInSeconds: 2 * turnSeconds });
  await boss.work(botQueue, async ([job]) => {
    if (job === undefined) return;
    await run(AbortSignal.any([job.signal, stopping.signal, AbortSignal.timeout(turnSeconds * 1000)]));
  });
  // The tick brings the loop back after a job that ended or failed. The first doesn't wait for it.
  await boss.schedule(botQueue, "* * * * *");
  await boss.send(botQueue);
  return () => {
    stopping.abort();
  };
}
