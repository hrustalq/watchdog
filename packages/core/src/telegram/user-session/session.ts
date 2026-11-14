// A Telegram user session, as the web sees it (ADR 0014, ADR 0032): it starts a login and writes
// each step on the login's row, and the worker's job answers there. Nothing here talks to Telegram,
// so web never loads mtcute and never decrypts a session.
import { and, type Db, eq, isNotNull, isNull, source, sql, telegramLogin, telegramSession, type Tx } from "@watchdog/db";
import { fromDrizzle, type PgBoss } from "pg-boss";
import { setPushSourceHealth } from "../../delivery/source-alert.ts";
import { encryptSecret } from "../../secrets/secrets.ts";

export const telegramLoginQueue = "telegram-login";
export const telegramRevokeQueue = "telegram-revoke";

/**
 * A heartbeat over 10 seconds old means no worker holds the login's client. Read on Postgres's clock,
 * which every heartbeat is written with, so the processes' own clocks don't matter.
 */
export const stale = sql`${telegramLogin.heartbeatAt} < now() - interval '10 seconds'`;

/** A revoke still waiting after this long has run out of retries, so it can be asked for again. */
const revokeStuck = sql`${telegramSession.revokedAt} < now() - interval '15 minutes'`;

/** What a session's Sources say once it ends, whether it was revoked or deleted unreadable. */
export const revokedError = "The Telegram session was revoked";

/** A Workspace's Sources that read through its session. */
export const sessionSources = (workspaceId: string) =>
  and(eq(source.workspaceId, workspaceId), eq(source.type, "telegram"), sql`${source.config}->>'via' = 'session'`);

export const loginExpired = "The login took longer than 5 minutes, so it ended. Start again.";
export const loginLost =
  "Watchdog's worker stopped in the middle of the login, so it ended. Start again, and Telegram sends a new code.";

export type Enqueue = (tx: Tx, id: string) => Promise<void>;

/** Queues a login's or a revoke's job over the transaction that writes its row, so they commit together. */
export function sessionJobEnqueuer(boss: PgBoss, queue: typeof telegramLoginQueue | typeof telegramRevokeQueue): Enqueue {
  return async (tx, id) => {
    await boss.insert(queue, [{ data: { id } }], { db: fromDrizzle(tx, sql) });
  };
}

/** What a login waits for, or why it ended. */
export type LoginState =
  | { step: "starting" | "code" | "password"; phone: string; refusal: string | null }
  | { step: "failed"; phone: string; refusal: string };

/** Spaces, dashes, dots and brackets, as people write numbers. Telegram takes 7 to 15 digits. */
function normalizePhone(input: string): string | undefined {
  const digits = input.replaceAll(/[\s().-]/g, "");
  return /^\+?\d{7,15}$/.test(digits) ? `+${digits.replace(/^\+/, "")}` : undefined;
}

/**
 * Starts a login with its job, in one transaction, replacing the Workspace's last one, whose job
 * then finds its row gone and ends.
 */
export async function startLogin(
  db: Db,
  workspaceId: string,
  input: string,
  enqueue: Enqueue,
): Promise<"started" | "invalid-phone" | "signed-in"> {
  const phone = normalizePhone(input);
  if (phone === undefined) return "invalid-phone";
  return db.transaction(async (tx) => {
    const [signedIn] = await tx
      .select({ id: telegramSession.id })
      .from(telegramSession)
      .where(eq(telegramSession.workspaceId, workspaceId));
    if (signedIn !== undefined) return "signed-in";
    await tx.delete(telegramLogin).where(eq(telegramLogin.workspaceId, workspaceId));
    const [login] = await tx.insert(telegramLogin).values({ workspaceId, phone }).returning({ id: telegramLogin.id });
    if (login === undefined) throw new Error("The login wasn't saved");
    await enqueue(tx, login.id);
    return "started";
  });
}

/**
 * Writes the code or the 2FA password, encrypted, for the worker to use. False when the login isn't
 * at that step, such as a form left open from an earlier step or a login that ended.
 */
export async function answerLogin(
  db: Db,
  encryptionKey: Buffer,
  workspaceId: string,
  step: "code" | "password",
  value: string,
): Promise<boolean> {
  // A code is digits, so stray spaces go. A password is used exactly as typed.
  const answer = step === "code" ? value.trim() : value;
  if (answer === "") return false;
  const ciphertext = encryptSecret(answer, encryptionKey);
  const saved = await db
    .update(telegramLogin)
    .set({
      refusal: null,
      ...(step === "code" ? { codeCiphertext: ciphertext } : { passwordCiphertext: ciphertext }),
    })
    .where(
      and(
        eq(telegramLogin.workspaceId, workspaceId),
        eq(telegramLogin.step, step),
        sql`${telegramLogin.expiresAt} > now()`,
      ),
    )
    .returning({ id: telegramLogin.id });
  return saved.length > 0;
}

/** Ends the Workspace's login, if it has one. Its job finds the row gone and ends. */
export async function cancelLogin(db: Db, workspaceId: string) {
  await db.delete(telegramLogin).where(eq(telegramLogin.workspaceId, workspaceId));
}

/** The Workspace's login as the screen shows it, or undefined when there is none. */
export async function loginState(db: Db, workspaceId: string): Promise<LoginState | undefined> {
  const [row] = await db
    .select({
      step: telegramLogin.step,
      phone: telegramLogin.phone,
      refusal: telegramLogin.refusal,
      expired: sql<boolean>`${telegramLogin.expiresAt} <= now()`,
      lost: sql<boolean>`${stale}`,
    })
    .from(telegramLogin)
    .where(eq(telegramLogin.workspaceId, workspaceId));
  if (row === undefined) return undefined;
  const { step, phone, refusal } = row;
  if (step === "failed") return { step, phone, refusal: refusal ?? loginLost };
  if (row.expired) return { step: "failed", phone, refusal: loginExpired };
  if (row.lost) return { step: "failed", phone, refusal: loginLost };
  return { step, phone, refusal };
}

/** The Workspace's session as the screen shows it. Its secret never leaves the database here. */
export async function sessionOf(db: Db, workspaceId: string) {
  const [row] = await db
    .select({
      account: telegramSession.account,
      revokedAt: telegramSession.revokedAt,
      unreadableAt: telegramSession.unreadableAt,
      revokeStuck: sql<boolean>`coalesce(${revokeStuck}, false)`,
      createdAt: telegramSession.createdAt,
    })
    .from(telegramSession)
    .where(eq(telegramSession.workspaceId, workspaceId));
  return row;
}

/**
 * Marks the session revoked and queues the job that logs it out on Telegram and deletes it, which
 * only the worker can do, because only the worker decrypts it. False when there is nothing to revoke,
 * or a revoke is already under way; one whose job ran out of retries can be asked for again.
 */
export async function requestRevoke(db: Db, workspaceId: string, enqueue: Enqueue): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(telegramSession)
      .set({ revokedAt: sql`now()` })
      .where(
        and(eq(telegramSession.workspaceId, workspaceId), sql`(${telegramSession.revokedAt} is null or ${revokeStuck})`),
      )
      .returning({ id: telegramSession.id });
    if (row === undefined) return false;
    await enqueue(tx, row.id);
    return true;
  });
}

/**
 * Deletes a session Watchdog recorded as unreadable, without logging it out on Telegram: only its
 * secret could do that, and that is what can't be read. Its Sources fail as a revoke's do. Refused
 * for a session Watchdog can still read, which the screen revokes instead.
 */
export async function deleteUnreadableSession(db: Db, workspaceId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(telegramSession)
      .where(and(eq(telegramSession.workspaceId, workspaceId), isNotNull(telegramSession.unreadableAt)))
      .returning({ id: telegramSession.id });
    if (deleted === undefined) return false;
    await setPushSourceHealth(tx, sessionSources(workspaceId), revokedError);
    return true;
  });
}

/**
 * The session's groups and channels for the screen, each with the Source that watches it, through
 * either path. Undefined until the runner has first read them from Telegram.
 */
export async function sessionChats(db: Db, workspaceId: string) {
  const [session] = await db
    .select({ dialogs: telegramSession.dialogs })
    .from(telegramSession)
    .where(eq(telegramSession.workspaceId, workspaceId));
  const dialogs = session?.dialogs ?? null;
  if (dialogs === null) return undefined;
  const watching = await db
    .select({ chat: source.dedupKey, name: source.name })
    .from(source)
    .where(and(eq(source.workspaceId, workspaceId), eq(source.type, "telegram")));
  const names = new Map(watching.map(({ chat, name }) => [chat, name]));
  return dialogs.map((chat) => ({ ...chat, watchedAs: names.get(String(chat.id)) ?? null }));
}

/**
 * Saves a chat from the session's dialog list as a session Source, named after the chat. Refused for
 * a chat the list doesn't have, and for one this Workspace already watches, through either path.
 */
export async function watchChat(
  db: Db,
  workspaceId: string,
  chatId: number,
): Promise<{ watched: string } | { refused: "not-listed" | "watched" }> {
  const [session] = await db
    .select({ dialogs: telegramSession.dialogs })
    .from(telegramSession)
    .where(and(eq(telegramSession.workspaceId, workspaceId), isNull(telegramSession.revokedAt)));
  const chat = session?.dialogs?.find(({ id }) => id === chatId);
  if (chat === undefined) return { refused: "not-listed" };
  const [saved] = await db
    .insert(source)
    .values({
      workspaceId,
      type: "telegram",
      name: chat.title,
      config: { via: "session", chatId, title: chat.title },
      schedule: null,
      nextPollAt: null,
    })
    .onConflictDoNothing()
    .returning({ name: source.name });
  return saved === undefined ? { refused: "watched" } : { watched: saved.name };
}
