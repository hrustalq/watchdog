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
// Telegram's limits are 1 message a second per chat and 30 a second across the bot. These leave a margin,
// because a request reaches Telegram a little later than it's let go, and not always equally later.
const chatGapMs = 1050;
const botGapMs = 35;
/** The longest wait a send takes on itself: past it, a caller that can reschedule is told when the turn is. */
const momentMs = 250;

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

/**
 * Takes a send's turn and says how long it is away. One worker sends alerts, so these limits can be kept in
 * memory. The web app's test alerts have a limiter of their own, so a test within a second of an alert to
 * the same chat can get a 429, which only that test or one attempt of the alert pays for.
 *
 * A turn is taken at the moment the message goes, so the gap that follows it is kept from a real send. A
 * caller that can send again takes no turn: it is told when its place in the chat's queue comes up, and its
 * job goes then, so nothing waits here on its behalf.
 */
function floodLimiter() {
  let botFreeAt = 0;
  const chatFreeAt = new Map<string, number>();
  /** When each chat's queued sends have had their turns: a rescheduled send's place among them. */
  const chatQueuedAt = new Map<string, number>();

  /** The wait until the chat's turn, which it takes when that is 0, or the one its caller resends for. */
  return (chatId: string, deferTurn: boolean) => {
    const now = Date.now();
    // A chat whose second has passed needs no entry, which keeps these to the last second's chats.
    for (const [chat, at] of chatFreeAt) if (at <= now) chatFreeAt.delete(chat);
    for (const [chat, at] of chatQueuedAt) if (at <= now) chatQueuedAt.delete(chat);

    const freeAt = Math.max(botFreeAt, chatFreeAt.get(chatId) ?? 0);
    const queuedAt = chatQueuedAt.get(chatId) ?? 0;
    if (freeAt > now) {
      if (freeAt - now > momentMs && deferTurn) {
        // Behind the sends already queued for this chat, which come a gap apart rather than in a crowd.
        const at = Math.max(freeAt, queuedAt);
        chatQueuedAt.set(chatId, at + chatGapMs);
        throw new NotYetSendError(at - now);
      }
      return freeAt - now;
    }

    botFreeAt = now + botGapMs;
    chatFreeAt.set(chatId, now + chatGapMs);
    chatQueuedAt.set(chatId, Math.max(queuedAt, now + chatGapMs));
    return 0;
  };
}

/** Without a token it sends nothing, and each attempt fails with a reason saying so. */
export function createTelegramSender(
  botToken: string | undefined,
  deps: {
    /** The egress guard's fetch, as for every request out of Watchdog. */
    fetch: ReturnType<typeof createEgressFetch>;
    encryptionKey: Buffer;
  },
): AlertSender {
  if (botToken === undefined) {
    return {
      send: () => Promise.reject(new Error("the Telegram bot isn't set up: TELEGRAM_BOT_TOKEN is empty")),
    };
  }
  const url = botApiUrl(botToken, "sendMessage");
  const nextTurn = floodLimiter();

  /**
   * Undefined when the message went, or else Telegram's refusal. The wait for the chat's turn happens here,
   * so the gap is kept from the moment the message goes. A job whose turn is further off than a moment is
   * told when it is instead, and goes again then.
   */
  const post = async (chatId: string, text: string, deferTurn: boolean) => {
    for (let waitMs = nextTurn(chatId, deferTurn); waitMs > 0; waitMs = nextTurn(chatId, deferTurn)) {
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
      let refused = await post(decryptSecret(destination.secretCiphertext, deps.encryptionKey), text, deferTurn);
      const movedTo = refused?.answer.parameters?.migrate_to_chat_id;
      // Once only, so a chat that keeps moving can't hold the send in a loop.
      if (movedTo !== undefined) {
        const chatId = String(movedTo);
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
        throw new RetryAfterSendError(
          `Telegram's flood limit asked to wait ${String(retryAfter)} seconds`,
          retryAfter * 1000,
        );
      }
      throw new Error(`Telegram refused the message with ${String(status)}${said}`);
    },
  };
}
