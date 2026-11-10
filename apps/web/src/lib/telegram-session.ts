// The Telegram user session screen's server side (ADR 0014, ADR 0032). Self-hosted with
// TELEGRAM_API_ID and TELEGRAM_API_HASH only: anywhere else every action refuses and writes nothing.
import { setTimeout as sleep } from "node:timers/promises";
import {
  answerLogin,
  cancelLogin,
  type LoginState,
  loginState,
  requestRevoke,
  sessionJobEnqueuer,
  startLogin,
  telegramLoginQueue,
  telegramRevokeQueue,
} from "@watchdog/core";
import type { Db } from "@watchdog/db";
import type { PgBoss } from "pg-boss";

export interface SessionAccess {
  db: Db;
  /** Self-hosted with the API variables set: loadConfig drops them on hosted. */
  available: boolean;
  encryptionKey: Buffer;
  boss: () => Promise<PgBoss>;
  /** How long an action waits for the worker to answer, so the page it lands on shows the answer. */
  waitMs?: number;
}

/**
 * Waits until the worker has answered, up to a few seconds, checking a few times a second. A
 * slower answer shows on the next load instead.
 */
async function untilAnswered(access: SessionAccess, workspaceId: string, answered: (state: LoginState | undefined) => boolean) {
  const deadline = Date.now() + (access.waitMs ?? 8_000);
  while (Date.now() < deadline) {
    if (answered(await loginState(access.db, workspaceId))) return;
    await sleep(250);
  }
}

export async function startTelegramLogin(access: SessionAccess, workspaceId: string, phone: string) {
  if (!access.available) return "unavailable";
  const started = await startLogin(access.db, workspaceId, phone, sessionJobEnqueuer(await access.boss(), telegramLoginQueue));
  if (started === "started") await untilAnswered(access, workspaceId, (state) => state?.step !== "starting");
  return started;
}

export async function answerTelegramLogin(access: SessionAccess, workspaceId: string, step: "code" | "password", value: string) {
  if (!access.available) return "unavailable";
  if ((step === "code" ? value.trim() : value) === "") return "empty";
  if (!(await answerLogin(access.db, access.encryptionKey, workspaceId, step, value))) return "not-asked";
  // Signed in, a refusal, or the next step.
  await untilAnswered(access, workspaceId, (state) => state?.step !== step || state.refusal !== null);
  return "answered";
}

export async function cancelTelegramLogin(access: SessionAccess, workspaceId: string) {
  if (access.available) await cancelLogin(access.db, workspaceId);
}

export async function revokeTelegramSession(access: SessionAccess, workspaceId: string) {
  if (!access.available) return false;
  return requestRevoke(access.db, workspaceId, sessionJobEnqueuer(await access.boss(), telegramRevokeQueue));
}
