// The worker side of a Telegram user session (ADR 0032): one `telegram-login` job holds the mtcute
// client from the phone number to the last step, answering on the login's row, and the revoke job
// logs a session out on Telegram before deleting it. Only these decrypt what the user gave.
import { setTimeout as sleep } from "node:timers/promises";
import { BaseTelegramClient, MemoryStorage, tl, User } from "@mtcute/node";
import { checkPassword, logOut, sendCode, signIn } from "@mtcute/node/methods.js";
import type { ITelegramClient } from "@mtcute/node";
import { and, type Db, eq, getTableColumns, isNull, lt, source, sql, telegramLogin, telegramSession } from "@watchdog/db";
import { decryptSecret, encryptSecret } from "../../secrets/secrets.ts";
import { loginLost, stale } from "./session.ts";

export interface SessionDeps {
  encryptionKey: Buffer;
  /** A client with nothing signed in. Each login and each revoke gets its own. */
  createClient: () => ITelegramClient;
  /** How often the job reads its row and writes its heartbeat. */
  tickMs?: number;
}

/** The client the worker runs, keeping its keys in memory: the session string is all that's stored. */
export function sessionClient(api: { id: number; hash: string }): ITelegramClient {
  return new BaseTelegramClient({ apiId: api.id, apiHash: api.hash, storage: new MemoryStorage(), logLevel: 0 });
}

export const revokedError = "The Telegram session was revoked";

// Telegram's refusals pass to the screen as these sentences, never as raw error text.
const refusals = {
  phoneInvalid: "Telegram doesn't take that phone number. Check it and start again.",
  phoneBanned: "Telegram has banned that phone number.",
  apiInvalid:
    "Telegram refused this install's TELEGRAM_API_ID and TELEGRAM_API_HASH. Whoever runs this Watchdog can check them at my.telegram.org.",
  tooMany: "Telegram asks to wait before another login. Try again later.",
  codeWrong: "That code is wrong. Check it in Telegram and enter it again.",
  codeExpired: "That code expired. Start again, and Telegram sends a new one.",
  passwordWrong: "That password is wrong. Enter it again.",
  failed: "Telegram didn't finish the login. Start again in a few minutes.",
};

const is = (error: unknown, ...names: string[]) => names.some((name) => tl.RpcError.is(error, name));
const floodWait = (error: unknown) => is(error, "FLOOD_WAIT_%d", "PHONE_NUMBER_FLOOD", "PHONE_PASSWORD_FLOOD");

function sendCodeRefusal(error: unknown) {
  if (is(error, "PHONE_NUMBER_INVALID")) return refusals.phoneInvalid;
  if (is(error, "PHONE_NUMBER_BANNED")) return refusals.phoneBanned;
  if (is(error, "API_ID_INVALID", "API_ID_PUBLISHED_FLOOD")) return refusals.apiInvalid;
  return floodWait(error) ? refusals.tooMany : refusals.failed;
}

function signInRefusal(error: unknown) {
  if (is(error, "PHONE_CODE_EXPIRED")) return refusals.codeExpired;
  return floodWait(error) ? refusals.tooMany : refusals.failed;
}

const accountName = (user: User) => (user.username === null ? user.displayName : `${user.displayName} (@${user.username})`);

/**
 * Runs one login until it's signed in, refused, replaced, past its 5 minutes, or the worker stops.
 * Never retried: a retry would make Telegram send a second code.
 */
export async function runLogin(db: Db, deps: SessionDeps, loginId: string, signal: AbortSignal): Promise<void> {
  // Rows whose job died with its worker, along with anything the user left on them.
  await db.delete(telegramLogin).where(lt(telegramLogin.expiresAt, sql`now()`));
  const [login] = await db
    .select({ ...getTableColumns(telegramLogin), lost: sql<boolean>`${stale}` })
    .from(telegramLogin)
    .where(eq(telegramLogin.id, loginId));
  if (login?.step !== "starting") return;

  const mine = eq(telegramLogin.id, loginId);
  const write = async (values: Partial<typeof telegramLogin.$inferInsert>, where = mine) => {
    await db.update(telegramLogin).set(values).where(where);
  };
  const fail = (refusal: string) => write({ step: "failed", refusal, codeCiphertext: null, passwordCiphertext: null });
  // The screen already told the user this login ended, because it waited in the queue too long.
  if (login.lost) return fail(loginLost);

  // Kept apart from the steps, so a slow call to Telegram doesn't look like a dead worker.
  const beat = () => db.update(telegramLogin).set({ heartbeatAt: sql`now()` }).where(mine).catch(() => undefined);
  await beat();
  const beating = setInterval(() => void beat(), deps.tickMs ?? 1000);

  /** Answers a refused step on the row. True when the refusal ends the login. */
  const refuse = async (error: unknown) => {
    // A wrong code or password isn't reported over a newer one the user has sent since.
    const unanswered = and(mine, isNull(telegramLogin.codeCiphertext), isNull(telegramLogin.passwordCiphertext));
    if (is(error, "SESSION_PASSWORD_NEEDED")) await write({ step: "password" });
    else if (is(error, "PHONE_CODE_INVALID", "PHONE_CODE_EMPTY")) await write({ refusal: refusals.codeWrong }, unanswered);
    else if (is(error, "PASSWORD_HASH_INVALID")) await write({ refusal: refusals.passwordWrong }, unanswered);
    else {
      await fail(signInRefusal(error));
      return true;
    }
    return false;
  };

  const client = deps.createClient();
  try {
    let phoneCodeHash: string;
    try {
      const sent = await sendCode(client, { phone: login.phone, abortSignal: signal });
      if (sent instanceof User) {
        await finish(db, deps, client, login, sent);
        return;
      }
      phoneCodeHash = sent.phoneCodeHash;
    } catch (error) {
      if (!signal.aborted) await fail(sendCodeRefusal(error));
      return;
    }
    await write({ step: "code" });

    for (;;) {
      // Rejects when the worker stops, which the next line sees.
      await sleep(deps.tickMs ?? 1000, undefined, { signal }).catch(() => undefined);
      if (signal.aborted) return;
      const pending = await claim(db, loginId);
      if (pending === undefined) return;
      const { step, code, password } = pending;
      let signing;
      if (step === "code" && code !== null) {
        const phoneCode = decryptSecret(code, deps.encryptionKey);
        signing = signIn(client, { phone: login.phone, phoneCodeHash, phoneCode, abortSignal: signal });
      } else if (step === "password" && password !== null) {
        signing = checkPassword(client, { password: decryptSecret(password, deps.encryptionKey), abortSignal: signal });
      } else continue;
      const outcome = await signing.then(
        (user) => ({ user }),
        async (error: unknown) => ({ ended: signal.aborted || (await refuse(error)) }),
      );
      if ("user" in outcome) {
        await finish(db, deps, client, login, outcome.user);
        return;
      }
      if (outcome.ended) return;
    }
  } finally {
    clearInterval(beating);
    await client.destroy();
  }
}

/**
 * Takes what the user gave since the last tick, clearing it from the row. Undefined when the login
 * is gone or past its 5 minutes, which then deletes it.
 */
async function claim(db: Db, loginId: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        step: telegramLogin.step,
        code: telegramLogin.codeCiphertext,
        password: telegramLogin.passwordCiphertext,
        expired: sql<boolean>`${telegramLogin.expiresAt} <= now()`,
      })
      .from(telegramLogin)
      .where(eq(telegramLogin.id, loginId))
      .for("update");
    if (row === undefined) return undefined;
    if (row.expired) {
      await tx.delete(telegramLogin).where(eq(telegramLogin.id, loginId));
      return undefined;
    }
    await tx
      .update(telegramLogin)
      .set({ codeCiphertext: null, passwordCiphertext: null })
      .where(eq(telegramLogin.id, loginId));
    return row;
  });
}

/**
 * Stores the session encrypted as the Workspace's one, and ends the login. A login cancelled or
 * replaced while Telegram signed it in, or a Workspace that has a session by now, keeps nothing,
 * and the new authorization is logged out, so none is left on the account that Watchdog can't revoke.
 */
async function finish(db: Db, deps: SessionDeps, client: ITelegramClient, login: { id: string; workspaceId: string }, user: User) {
  const secretCiphertext = encryptSecret(await client.exportSession(), deps.encryptionKey);
  const stored = await db.transaction(async (tx) => {
    const [claimed] = await tx.delete(telegramLogin).where(eq(telegramLogin.id, login.id)).returning({ id: telegramLogin.id });
    if (claimed === undefined) return false;
    const [row] = await tx
      .insert(telegramSession)
      .values({ workspaceId: login.workspaceId, account: accountName(user), secretCiphertext })
      .onConflictDoNothing()
      .returning({ id: telegramSession.id });
    return row !== undefined;
  });
  if (!stored) await logOut(client).catch(() => undefined);
}

/**
 * Logs the session out on Telegram, then deletes it and fails the Sources that read through it. A
 * session Telegram already ended is deleted all the same. Any other error throws, so pg-boss retries.
 */
export async function revokeSession(db: Db, deps: SessionDeps, sessionId: string): Promise<void> {
  const [session] = await db.select().from(telegramSession).where(eq(telegramSession.id, sessionId));
  if (session === undefined) return;
  const client = deps.createClient();
  try {
    await client.importSession(decryptSecret(session.secretCiphertext, deps.encryptionKey));
    await logOut(client).catch((error: unknown) => {
      if (!is(error, "AUTH_KEY_UNREGISTERED", "SESSION_REVOKED", "SESSION_EXPIRED", "USER_DEACTIVATED")) throw error;
    });
  } finally {
    await client.destroy();
  }
  await db.transaction(async (tx) => {
    await tx.delete(telegramSession).where(eq(telegramSession.id, sessionId));
    await tx
      .update(source)
      .set({ health: "failing", lastError: revokedError, lastErrorAt: sql`now()` })
      .where(
        and(eq(source.workspaceId, session.workspaceId), eq(source.type, "telegram"), sql`${source.config}->>'via' = 'session'`),
      );
  });
}
