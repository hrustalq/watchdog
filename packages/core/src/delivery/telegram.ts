// Sends alerts through the install's Telegram bot (docs: Actions and delivery, "Telegram chats" and
// "Alerts"; ADR 0029).
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { createEgressFetch } from "../egress/egress.ts";
import { decryptSecret, encryptSecret } from "../secrets/secrets.ts";
import type { AlertMessage } from "./content.ts";
import { type AlertSender, FinalSendError, NotYetSendError, RetryAfterSendError, unreachable } from "./deliver.ts";
import { groupedAlertText } from "./group.ts";
import { sourceAlertText } from "./source-alert-content.ts";

const maxLength = 4096;
// Telegram's limits are 1 message a second per chat, 30 a second across the bot and 20 a minute in a group.
// These leave a margin, because a request reaches Telegram a little later than it's let go, and not always
// equally later.
const chatGapMs = 1050;
const botGapMs = 35;
/** Telegram's FAQ allows a bot 20 messages a minute in a group. */
const groupLimit = 20;
const groupGapMs = 61_000;
/**
 * The longest wait a send takes on itself: past it, a caller that can reschedule is told when the turn is,
 * and the bot runner drops a reply it may drop rather than hold every other chat up for it.
 */
export const floodMomentMs = 250;

export const botApiUrl = (botToken: string, method: string) => `https://api.telegram.org/bot${botToken}/${method}`;

/** What Telegram's answer holds when it refuses a request. Anything else, such as a proxy's page, has neither. */
export const refusal = z
  .object({
    description: z.string().optional(),
    parameters: z
      .object({
        retry_after: z.number().positive().optional(),
        // A group that became a supergroup has a new id, of at most 52 bits, which a number holds exactly.
        migrate_to_chat_id: z.number().int().optional().catch(undefined),
      })
      .optional(),
  })
  .catch({});

/**
 * Plain text, with no `parse_mode`, so nothing in an Item's text can format the message. JavaScript's length
 * counts UTF-16 units, at least as many as the characters Telegram counts, so the cut is always in time.
 */
function alertText({ title, source, rating, summary, link, why }: AlertMessage) {
  const heading = `${title}\n${source} · ${rating}\nWhy: ${why}`;
  const body = summary === null || summary === "" ? heading : `${heading}\n\n${summary}`;
  const ending = `\n\n${link}`;
  const room = maxLength - ending.length;
  if (body.length <= room) return body + ending;
  // A cut between the two halves of an emoji would leave text Telegram refuses.
  return `${body.slice(0, room - 1).replace(/[\uD800-\uDBFF]$/, "")}…${ending}`;
}

/** A group, supergroup or channel, as the Bot API gives it: their ids are negative, and a private chat's id is
 * positive. Only a group has the 20-a-minute limit.
 */
const isGroup = (chatId: string) => chatId.startsWith("-");

/** What a send that Telegram's flood limit has paused says in the Log, with the whole seconds it has left. */
const floodLimitReason = (ms: number) =>
  `Telegram's flood limit asked to wait ${String(Math.ceil(ms / 1000))} seconds`;

/**
 * Takes a send's turn and says how long it is away. One limiter keeps Telegram's flood limits for a bot: the
 * worker shares one between its Delivery sender and the bot runner's replies, and the web app has its own for
 * test alerts. A 429's wait is kept per chat, and a group has a budget of its own.
 *
 * A turn is taken at the moment the message goes, so the gap that follows it is kept from a real send. A
 * caller that can send again takes no turn: it is told when its place in the chat's queue comes up, and its
 * job goes then, so nothing waits here on its behalf.
 */
export function createFloodLimiter() {
  let botFreeAt = 0;
  const chatFreeAt = new Map<string, number>();
  /** When each chat's queued sends have had their turns: a rescheduled send's place among them. */
  const chatQueuedAt = new Map<string, number>();
  /**
   * A chat whose next send may wait in place for its turn, because the Delivery's own time has come and
   * the place it was given is about to: queuing it again would come back a poll later and slip every
   * turn behind it. Expires, so a send that never comes can't hold another one back.
   */
  const chatHeldUntil = new Map<string, number>();
  /** When each group's last sends went, oldest first: what its budget counts. */
  const groupSends = new Map<string, number[]>();
  /** A chat Telegram refused with a 429, and the moment its `retry_after` has passed. */
  const chatPausedUntil = new Map<string, number>();

  /** A chat whose second has passed needs no entry, which keeps these to the last second's chats. */
  const forgetOld = (now: number) => {
    for (const [chat, at] of chatFreeAt) if (at <= now) chatFreeAt.delete(chat);
    for (const [chat, at] of chatQueuedAt) if (at <= now) chatQueuedAt.delete(chat);
    for (const [chat, at] of chatHeldUntil) if (at <= now) chatHeldUntil.delete(chat);
    for (const [chat, at] of chatPausedUntil) if (at <= now) chatPausedUntil.delete(chat);
    for (const [chat, sends] of groupSends) {
      const live = sends.filter((at) => at > now - groupGapMs);
      if (live.length === 0) groupSends.delete(chat);
      else groupSends.set(chat, live);
    }
  };

  /** When the group's budget lets another message go, or 0 when it has room. */
  const groupFreeAt = (chatId: string, now: number) => {
    if (!isGroup(chatId)) return 0;
    const sends = groupSends.get(chatId) ?? [];
    if (sends.length < groupLimit) return 0;
    return (sends[sends.length - groupLimit] ?? now) + groupGapMs;
  };

  /** The moment the chat may be sent to: its own gap, the bot's, a 429's wait and the group's budget. */
  const freeAtOf = (chatId: string, now: number) =>
    Math.max(
      botFreeAt,
      chatFreeAt.get(chatId) ?? 0,
      chatPausedUntil.get(chatId) ?? 0,
      groupFreeAt(chatId, now),
    );

  const takeTurn = (chatId: string, now: number) => {
    botFreeAt = now + botGapMs;
    chatFreeAt.set(chatId, now + chatGapMs);
    if (!isGroup(chatId)) return;
    const sends = groupSends.get(chatId) ?? [];
    sends.push(now);
    groupSends.set(chatId, sends);
  };

  /** The wait until the chat's turn, which it takes when that is 0, or the one its caller resends for. */
  const nextTurn = (chatId: string, deferTurn: boolean) => {
    const now = Date.now();
    forgetOld(now);

    const freeAt = freeAtOf(chatId, now);
    const queuedAt = chatQueuedAt.get(chatId) ?? 0;
    if (freeAt > now) {
      // A place that has come is waited out here rather than queued again, which would come back late.
      const held = chatHeldUntil.get(chatId);
      chatHeldUntil.delete(chatId);
      if (held === undefined && freeAt - now > floodMomentMs && deferTurn) {
        // Behind the sends already queued for this chat, which come a gap apart rather than in a crowd.
        const at = Math.max(freeAt, queuedAt);
        chatQueuedAt.set(chatId, at + chatGapMs);
        throw new NotYetSendError(at - now);
      }
      return freeAt - now;
    }

    takeTurn(chatId, now);
    chatQueuedAt.set(chatId, Math.max(queuedAt, now + chatGapMs));
    return 0;
  };

  /**
   * How long until the chat's turn, with a place taken in the chat's queue for a send that comes back
   * then, or undefined when a send can go within a moment.
   *
   * A place is taken even by a caller that sends now, because jobs are fetched in a batch: without one
   * the jobs beside it find the chat free too, and each waits for the one before it on the Destination's
   * row, holding a queue slot until the turn is a moment away. `dueAt` is when the Delivery's own time
   * came: a send given a place takes it, rather than going behind the places handed out since.
   */
  const placeInQueue = (chatId: string, dueAt: Date | null): number | undefined => {
    const now = Date.now();
    forgetOld(now);

    const freeAt = freeAtOf(chatId, now);
    // A place that has come is taken now, or waited out here when it is barely a gap away: queued again it
    // would come back a poll later, and the turns behind it would slip with it.
    if (dueAt !== null && dueAt.getTime() <= now + floodMomentMs) {
      if (freeAt - now <= chatGapMs) {
        chatHeldUntil.set(chatId, freeAt);
        return undefined;
      }
      return freeAt - now;
    }

    const at = Math.max(freeAt, chatQueuedAt.get(chatId) ?? 0, now);
    chatQueuedAt.set(chatId, at + chatGapMs);
    return at - now > floodMomentMs ? at - now : undefined;
  };

  return {
    nextTurn,
    placeInQueue,
    /**
     * The wait until the chat's turn, taking it when there is one. Unlike `nextTurn`, a caller that can't have
     * the turn now books no place, so one that will never send leaves nothing behind: the bot runner's replies
     * use this, because so many of them are dropped.
     */
    tryTurn: (chatId: string) => {
      const now = Date.now();
      forgetOld(now);
      const freeAt = freeAtOf(chatId, now);
      if (freeAt > now) return freeAt - now;
      takeTurn(chatId, now);
      chatQueuedAt.set(chatId, Math.max(chatQueuedAt.get(chatId) ?? 0, now + chatGapMs));
      return 0;
    },
    /**
     * Keeps Telegram's asked wait for the chat, so nothing else reaches it until then. A 429's `retry_after`
     * is in seconds; the wait ends later than this call, because the answer took time to arrive.
     */
    pause: (chatId: string, ms: number) => {
      chatPausedUntil.set(chatId, Math.max(chatPausedUntil.get(chatId) ?? 0, Date.now() + ms));
    },
    /** How long the chat must wait before another send, or undefined when Telegram hasn't asked for one. */
    pausedFor: (chatId: string) => {
      const until = chatPausedUntil.get(chatId) ?? 0;
      return until > Date.now() ? until - Date.now() : undefined;
    },
  };
}

export type FloodLimiter = ReturnType<typeof createFloodLimiter>;

/** Without a token it sends nothing, and each attempt fails with a reason saying so. */
export function createTelegramSender(
  botToken: string | undefined,
  deps: {
    /** The egress guard's fetch, as for every request out of Watchdog. */
    fetch: ReturnType<typeof createEgressFetch>;
    encryptionKey: Buffer;
    /** The limits to keep to, which the worker shares with the bot runner's replies. Own when not given. */
    limiter?: FloodLimiter;
  },
): AlertSender {
  if (botToken === undefined) {
    return {
      send: () => Promise.reject(new Error("the Telegram bot isn't set up: TELEGRAM_BOT_TOKEN is empty")),
    };
  }
  const url = botApiUrl(botToken, "sendMessage");
  const turn = deps.limiter ?? createFloodLimiter();

  /**
   * Undefined when the message went, or else Telegram's refusal. The wait for the chat's turn happens here,
   * so the gap is kept from the moment the message goes. A job whose turn is further off than a moment is
   * told when it is instead, and goes again then.
   *
   * A chat Telegram's flood limit has paused is refused here, with the time left, rather than waited out: a
   * long wait would hold the job slot, and the Delivery's next attempt is queued for that time instead.
   */
  const post = async (chatId: string, text: string, deferTurn: boolean) => {
    const paused = turn.pausedFor(chatId);
    if (paused !== undefined) {
      throw new RetryAfterSendError(floodLimitReason(paused), paused);
    }
    for (let waitMs = turn.nextTurn(chatId, deferTurn); waitMs > 0; waitMs = turn.nextTurn(chatId, deferTurn)) {
      await sleep(waitMs);
    }
    const response = await deps
      .fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          // Telegram would otherwise fetch and show the first URL in the text, which an Item's text can choose.
          link_preview_options: { is_disabled: true },
        }),
      })
      .catch((error: unknown) => {
        throw unreachable(error, "Telegram");
      });
    if (response.ok) {
      // The message went, whatever happens to the rest of the answer. Reading it keeps the connection open.
      await response.arrayBuffer().catch(() => undefined);
      return undefined;
    }
    return { status: response.status, answer: refusal.parse(await response.json().catch(() => undefined)) };
  };

  return {
    send: async (destination, message, onChatMoved, options) => {
      if (destination.secretCiphertext === null) throw new Error("the Telegram chat isn't linked");
      const deferTurn = options?.deferTurn === true;
      let text: string;
      if ("health" in message) text = sourceAlertText(message);
      else text = "lines" in message ? groupedAlertText(message, maxLength) : alertText(message);
      let chatId = decryptSecret(destination.secretCiphertext, deps.encryptionKey);
      let refused = await post(chatId, text, deferTurn);
      const movedTo = refused?.answer.parameters?.migrate_to_chat_id;
      // Once only, so a chat that keeps moving can't hold the send in a loop.
      if (movedTo !== undefined) {
        chatId = String(movedTo);
        await onChatMoved?.(encryptSecret(chatId, deps.encryptionKey));
        refused = await post(chatId, text, deferTurn);
      }
      if (refused === undefined) return;

      const { status, answer } = refused;
      const said = answer.description === undefined ? "" : `: ${answer.description}`;
      if (status === 403) {
        throw new FinalSendError(`the bot was removed from the chat or blocked (Telegram said ${String(status)}${said})`);
      }
      const retryAfter = answer.parameters?.retry_after;
      if (status === 429 && retryAfter !== undefined) {
        // Telegram's answer says the whole bot is over a limit, but its docs don't say so for a chat, so the
        // wait is kept per chat: if the Log shows the bot itself refused, this is where that would change.
        turn.pause(chatId, retryAfter * 1000);
        throw new RetryAfterSendError(floodLimitReason(retryAfter * 1000), retryAfter * 1000);
      }
      throw new Error(`Telegram refused the message with ${String(status)}${said}`);
    },
    deferTurn: (destination, dueAt) => {
      // An unlinked chat has no turn to keep, and says so when the send is tried.
      if (destination.secretCiphertext === null) return undefined;
      return turn.placeInQueue(decryptSecret(destination.secretCiphertext, deps.encryptionKey), dueAt);
    },
  };
}
