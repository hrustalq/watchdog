// A Telegram user session's runner (docs: Sources and ingestion, "Telegram user session"): one
// exclusive job per session, like the bot's, that turns messages in its Sources' chats into Items.
// Each turn reads the dialog list for the screen, backfills new Sources, catches up on what came in
// since the last turn, then captures new messages as they arrive, until the turn ends or the session
// is revoked.
import { setTimeout as sleep } from "node:timers/promises";
import { type Chat, getMarkedPeerId, type ITelegramClient, Message, MtPeerNotFoundError, parseMarkedPeerId, tl, toggleChannelIdMark } from "@mtcute/node";
import { getHistory, iterDialogs } from "@mtcute/node/methods.js";
import { and, type Db, eq, isNull, or, source, sql, type TelegramDialog, telegramSession } from "@watchdog/db";
import { captureItems, type CaptureDeps } from "../../pipeline/capture.ts";
import { decryptSecret } from "../../secrets/secrets.ts";
import { telegramDraft } from "../../sources/telegram/draft.ts";
import type { BotMessage } from "../update.ts";
import { endedByTelegram, sessionSources } from "./login.ts";
import { FloodWaitTooLong, readOnly } from "./read-only.ts";

export const loggedOutError = "The Telegram session was logged out";
const unreadable = "The Telegram session can't read this chat. The account may have left it, or been removed from it.";

/** A Backfill reads Telegram's newest 50, which capture cuts to the Backfill's window. */
const backfillLimit = 50;
/** A catch-up reads back to the last message read, a page at a time, up to 1,000 messages. */
const catchUpPage = 100;
const catchUpPages = 10;
/** A list of more dialogs than this is cut, so one turn's start costs at most a few calls. */
const dialogLimit = 500;

export interface RunnerDeps extends CaptureDeps {
  encryptionKey: Buffer;
  /** A client with nothing signed in, which the runner imports the session into. */
  createClient: () => ITelegramClient;
  /** How often the runner checks the session and its Sources. */
  tickMs?: number;
  /** How often it asks Telegram whether the session still works, since a quiet one makes no calls. */
  checkMs?: number;
}

/** The sessions whose turn the tick starts: not being revoked, and not waiting out a FLOOD_WAIT. */
export async function liveSessions(db: Db) {
  return db
    .select({ id: telegramSession.id })
    .from(telegramSession)
    .where(and(isNull(telegramSession.revokedAt), or(isNull(telegramSession.waitUntil), sql`${telegramSession.waitUntil} <= now()`)));
}

/** The Bot API's chat types, which the list, the drafts and the links share. Undefined for any other. */
function chatType({ chatType: type }: Chat): TelegramDialog["type"] | undefined {
  if (type === "group" || type === "channel" || type === "supergroup") return type;
  return type === "gigagroup" ? "supergroup" : undefined;
}

/** A message in the Bot API's shape, so it becomes an Item by the bot's rules. Undefined for a service message. */
function asBotMessage(message: Message): BotMessage | undefined {
  const { chat, sender, raw } = message;
  const type = chat.type === "chat" ? chatType(chat) : undefined;
  if (message.isService || chat.type !== "chat" || type === undefined) return undefined;
  return {
    message_id: message.id,
    date: raw.date,
    chat: { id: chat.id, type, title: chat.title, ...(chat.username !== null && { username: chat.username }) },
    from: sender.type === "user" ? { first_name: sender.firstName, ...(sender.lastName !== null && { last_name: sender.lastName }) } : undefined,
    author_signature: raw._ === "message" ? raw.postAuthor : undefined,
    text: message.text,
  };
}

/** Runs again after a FLOOD_WAIT, which the read-only client waits out before the call. */
async function waitingOutFloods<T>(read: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await read();
    } catch (error) {
      if (!tl.RpcError.is(error, "FLOOD_WAIT_%d")) throw error;
    }
  }
}

interface Watched {
  sourceId: string;
  /** The newest message id read, where the next turn's catch-up starts. */
  lastId: number;
  /** A capture failed this turn, so lastId stays put and the next turn's catch-up reads it again. */
  held?: true;
}

/**
 * Runs one turn of the session until the signal ends, the session is revoked or logged out, or a
 * FLOOD_WAIT lasts past `until`, which is stored so the tick starts no turn before it.
 */
export async function runSession(db: Db, deps: RunnerDeps, sessionId: string, { signal, until }: { signal: AbortSignal; until: Date }) {
  const [session] = await db.select().from(telegramSession).where(eq(telegramSession.id, sessionId));
  if (session === undefined || session.revokedAt !== null) return;
  if (session.waitUntil !== null && session.waitUntil > new Date()) return;
  const live = and(eq(telegramSession.id, sessionId), isNull(telegramSession.revokedAt));

  const client = readOnly(deps.createClient(), [], { until, signal });
  /** The Sources read this turn, by chat id. Only these take messages as they arrive. */
  const watched = new Map<number, Watched>();
  /** Sources this turn couldn't read, which wait for the next turn rather than being asked each tick. */
  const unread = new Set<string>();
  // Reads and captures run one at a time, in the order they came, so a message that arrives while
  // its Source's Backfill is read is captured after the Backfill, never as part of it.
  let captures: Promise<unknown> = Promise.resolve();
  const serially = <T>(work: () => Promise<T>) => {
    const done = captures.then(work);
    captures = done.catch(() => undefined);
    return done;
  };

  const take = async (into: Watched, messages: Message[]) => {
    const drafts = messages.flatMap((message) => {
      const draft = asBotMessage(message);
      return draft === undefined ? [] : (telegramDraft(draft) ?? []);
    });
    const lastId = into.held ? into.lastId : Math.max(into.lastId, ...messages.map(({ id }) => id));
    const fetchState = { lastMessageId: String(lastId) };
    await captureItems(db, into.sourceId, drafts, { at: deps.now?.() ?? new Date(), polled: false, fetchState }, deps);
    into.lastId = lastId;
  };

  /** A group that became a supergroup: its Source follows it, unless the Workspace already watches that. */
  const migrate = async (into: Watched, from: number, to: number) => {
    const watchesIt = sql`exists (select 1 from source s where s.workspace_id = ${source.workspaceId}
      and s.type = 'telegram' and s.dedup_key = ${String(to)})`;
    // The supergroup numbers its messages afresh.
    await db
      .update(source)
      .set({ config: sql`jsonb_set(${source.config}, '{chatId}', to_jsonb(${to}::bigint))`, fetchState: { lastMessageId: "0" } })
      .where(and(eq(source.id, into.sourceId), sql`not ${watchesIt}`));
    // The next tick reads it under its new id.
    watched.delete(from);
  };

  client.onRawUpdate.add(({ update, peers }) => {
    // New messages only: an edit is never captured again.
    if (update._ !== "updateNewMessage" && update._ !== "updateNewChannelMessage") return;
    const sent = update.message;
    if (sent._ === "messageEmpty") return;
    // Looked up by the raw peer first, so a chat nobody watches, such as a private one, is never parsed.
    const chatId = getMarkedPeerId(sent.peerId);
    const into = watched.get(chatId);
    if (into === undefined) return;
    let work = () => take(into, [new Message(sent, peers)]);
    if (sent._ === "messageService" && sent.action._ === "messageActionChatMigrateTo") {
      const to = toggleChannelIdMark(sent.action.channelId);
      work = () => migrate(into, chatId, to);
    }
    serially(work).catch((error: unknown) => {
      into.held = true;
      process.stderr.write(`Capturing a Telegram message failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  });

  /** The Backfill's newest 50, or everything after `minId`, newest first, a page at a time. */
  const history = async (chatId: number, minId?: number) => {
    if (minId === undefined) return waitingOutFloods(() => getHistory(client, chatId, { limit: backfillLimit }));
    const messages: Message[] = [];
    let offset: { id: number; date: number } | undefined;
    for (let page = 0; page < catchUpPages; page += 1) {
      const from = offset;
      const got = await waitingOutFloods(() => getHistory(client, chatId, { limit: catchUpPage, minId, ...(from && { offset: from }) }));
      messages.push(...got);
      if (got.length < catchUpPage) break;
      offset = got.next;
    }
    return messages;
  };

  /** A new Source's Backfill, or what came in since the last turn's newest message. */
  const read = async (row: Pick<typeof source.$inferSelect, "id" | "config" | "backfilledAt" | "fetchState">) => {
    const chatId = "chatId" in row.config ? row.config.chatId : undefined;
    if (chatId === undefined) return;
    const into = { sourceId: row.id, lastId: Number(row.fetchState.lastMessageId ?? 0) };
    // Watched from before the read, so nothing that arrives during it is missed.
    watched.set(chatId, into);
    try {
      // mtcute polls a supergroup's or channel's updates only once it's told the chat is open.
      const [kind, bareId] = parseMarkedPeerId(chatId);
      if (kind === "channel") await client.notifyChannelOpened(bareId);
      await serially(async () => take(into, await history(chatId, row.backfilledAt === null ? undefined : into.lastId)));
      // Read again, such as after the account rejoined the chat or signed in again.
      await db.update(source).set({ health: "ok" }).where(and(eq(source.id, row.id), eq(source.health, "failing")));
    } catch (error) {
      watched.delete(chatId);
      if (error instanceof FloodWaitTooLong || endedByTelegram(error)) throw error;
      if (!tl.RpcError.is(error) && !(error instanceof MtPeerNotFoundError)) throw error;
      // The chat is gone from the account, or Telegram won't say: the Source shows it.
      unread.add(row.id);
      await db.update(source).set({ health: "failing", lastError: unreadable, lastErrorAt: new Date() }).where(eq(source.id, row.id));
    }
  };

  try {
    await client.importSession(decryptSecret(session.secretCiphertext, deps.encryptionKey));
    const dialogs: TelegramDialog[] = [];
    await waitingOutFloods(async () => {
      dialogs.length = 0;
      for await (const { peer } of iterDialogs(client, { archived: "keep", limit: dialogLimit })) {
        if (peer.type !== "chat") continue;
        const type = chatType(peer);
        if (type !== undefined) dialogs.push({ id: peer.id, title: peer.title, type });
      }
    });
    await db.update(telegramSession).set({ dialogs }).where(live);
    await client.startUpdatesLoop();

    let checkedAt = Date.now();
    while (!signal.aborted) {
      // An answer that the session ended throws, and the catch below logs it out here too.
      if (Date.now() - checkedAt >= (deps.checkMs ?? 60_000)) {
        await waitingOutFloods(() => client.call({ _: "updates.getState" }));
        checkedAt = Date.now();
      }
      const [still] = await db.select({ id: telegramSession.id }).from(telegramSession).where(live);
      if (still === undefined) return;
      const rows = await db
        .select({ id: source.id, config: source.config, backfilledAt: source.backfilledAt, fetchState: source.fetchState })
        .from(source)
        .where(sessionSources(session.workspaceId));
      const ids = new Set(rows.map(({ id }) => id));
      for (const [chatId, { sourceId }] of watched) if (!ids.has(sourceId)) watched.delete(chatId);
      const reading = new Set([...watched.values()].map(({ sourceId }) => sourceId));
      for (const row of rows) if (!reading.has(row.id) && !unread.has(row.id)) await read(row);
      await sleep(deps.tickMs ?? 5_000, undefined, { signal }).catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof FloodWaitTooLong) {
      await db.update(telegramSession).set({ waitUntil: error.until }).where(eq(telegramSession.id, sessionId));
    } else if (endedByTelegram(error)) {
      await loggedOut(db, sessionId, session.workspaceId);
    } else if (!signal.aborted) throw error;
  } finally {
    await client.stopUpdatesLoop();
    await captures;
    await client.destroy();
  }
}

/**
 * Telegram ended the session, for example from the user's phone: it is deleted, and its Sources
 * fail. A session being revoked is left to its revoke, which says so instead.
 */
async function loggedOut(db: Db, sessionId: string, workspaceId: string) {
  await db.transaction(async (tx) => {
    const [ended] = await tx
      .delete(telegramSession)
      .where(and(eq(telegramSession.id, sessionId), isNull(telegramSession.revokedAt)))
      .returning({ id: telegramSession.id });
    if (ended === undefined) return;
    await tx.update(source).set({ health: "failing", lastError: loggedOutError, lastErrorAt: sql`now()` }).where(sessionSources(workspaceId));
  });
}
