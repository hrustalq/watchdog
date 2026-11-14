// The Telegram bot's one getUpdates loop (ADR 0029). It links chats to Destinations and Sources through
// `/start <code>` (docs: Actions and delivery, "Telegram chats"), and hands every other update to intake
// (docs: Sources and ingestion, "Telegram bot intake").
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { botApiUrl, type FloodLimiter, floodMomentMs, refusal } from "../delivery/telegram.ts";
import { unreachable } from "../delivery/deliver.ts";
import type { createEgressFetch } from "../egress/egress.ts";
import { type BotUpdate, botUpdate } from "./update.ts";

type BotFetch = ReturnType<typeof createEgressFetch>;

/** Under the egress guard's 30 seconds, so a quiet poll ends before the guard calls it too slow. */
const pollSeconds = 25;

/**
 * In a group, Telegram's privacy mode only promises a bot the command addressed to it, `/start@bot <code>`,
 * which is also what a `startgroup` link sends. A plain `/start <code>` there may or may not arrive.
 */
const startCommand = /^\/start(?:@(\w+))?\s+(\S+)\s*$/;

/** How often an update may fail while the database answers, before the runner moves past it. */
const attemptsPerUpdate = 3;

async function callBot<T>(
  { botToken, fetch }: { botToken: string; fetch: BotFetch },
  method: string,
  body: object,
  result: z.ZodType<T>,
  signal?: AbortSignal,
) {
  const response = await fetch(botApiUrl(botToken, method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal && { signal }),
  }).catch((error: unknown) => {
    throw unreachable(error, "Telegram");
  });
  const answer: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const { description } = refusal.parse(answer);
    const said = description === undefined ? "" : `: ${description}`;
    throw new Error(`Telegram refused ${method} with ${String(response.status)}${said}`);
  }
  return result.parse(z.looseObject({ result: z.unknown() }).parse(answer).result);
}

/** The bot's username, for the link a person opens and to know which commands are addressed to it. */
export async function botUsername(botToken: string, fetch: BotFetch, signal?: AbortSignal) {
  const me = await callBot({ botToken, fetch }, "getMe", {}, z.object({ username: z.string() }), signal);
  return me.username;
}

/** The chat a `/start <code>` came from. A private chat has no title, so it goes by "Private chat". */
export interface BotChat {
  id: string;
  title: string;
  /** Telegram's chat type: private, group, supergroup or channel. */
  type: string;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Reads the bot's updates until the signal ends. An update counts as read only once it's handled, because
 * Telegram resends everything from the offset of the last poll on. So a failure, logged here, tries again
 * after `retryMs`, and a stop in the middle of a batch can bring a `/start` back with a reply that the code is gone.
 * An update that fails `attemptsPerUpdate` times while the database answers is skipped, so it can't hold up
 * the ones behind it. While the database is down every update waits, so an outage loses none.
 */
export async function runBot(
  deps: {
    botToken: string;
    fetch: BotFetch;
    /** The limits the bot's replies keep to: the worker's one for its alerts too, so both count together. */
    floodLimiter: FloodLimiter;
    /** Spends a code on a chat, and gives the reply for the chat. */
    linkChat: (code: string, chat: BotChat) => Promise<string>;
    /**
     * Whether this reply may be dropped when the chat is over its flood limit, rather than waiting for its
     * turn: the runner handles one update at a time, so waiting would hold up every other chat. A reply about
     * an unknown or expired code is the one that may go, and a reply that linked the chat never does.
     */
    mayDropReply?: (reply: string) => boolean;
    /** Every update that isn't a code: messages to capture, and changes to the bot's place in a chat. */
    intake: (update: BotUpdate) => Promise<unknown>;
    /** Rejects when the database can't be reached. */
    pingDatabase: () => Promise<unknown>;
    retryMs?: number;
  },
  signal: AbortSignal,
) {
  const { linkChat, intake, pingDatabase, retryMs = 15_000, floodLimiter, mayDropReply } = deps;
  let username: string | undefined;
  let offset: number | undefined;
  let failedId: number | undefined;
  let attempts = 0;

  /**
   * Says `text` in the chat, taking its turn in the same flood limits as the alerts. A reply that may drop is
   * dropped when its chat or the bot needs longer than a moment, rather than waited for; any other reply waits
   * for its turn, and neither takes a place in the chat's queue unless it sends.
   */
  const reply = async (chatId: number, text: string, mayDrop: boolean) => {
    const chat = String(chatId);
    for (let waitMs = floodLimiter.tryTurn(chat); waitMs > 0; waitMs = floodLimiter.tryTurn(chat)) {
      if (mayDrop && waitMs > floodMomentMs) return;
      await sleep(waitMs);
    }
    // A chat that can't be answered, such as one that blocked the bot, must not hold up everyone else's.
    await callBot(deps, "sendMessage", { chat_id: chatId, text, link_preview_options: { is_disabled: true } }, z.unknown()).catch(
      (error: unknown) => {
        process.stderr.write(`Replying in a Telegram chat failed: ${messageOf(error)}\n`);
      },
    );
  };

  const startOf = (update: BotUpdate, bot: string) => {
    // A channel's admins post the command, which comes as a channel post.
    const post = update.message ?? update.channel_post;
    const [, addressedTo, code] = startCommand.exec(post?.text ?? "") ?? [];
    if (post === undefined || code === undefined) return undefined;
    if (addressedTo !== undefined && addressedTo.toLowerCase() !== bot.toLowerCase()) return undefined;
    return { code, chat: post.chat };
  };

  const link = async ({ code, chat }: NonNullable<ReturnType<typeof startOf>>) => {
    const { id, title = "Private chat", type } = chat;
    const answer = await linkChat(code, { id: String(id), title, type });
    await reply(id, answer, mayDropReply?.(answer) === true);
  };

  // A function, because TypeScript would otherwise take `aborted` as still false inside the loop.
  const stopped = () => signal.aborted;
  while (!stopped()) {
    try {
      const bot = (username ??= await botUsername(deps.botToken, deps.fetch, signal));
      const updates = await callBot(
        deps,
        "getUpdates",
        {
          ...(offset !== undefined && { offset }),
          timeout: pollSeconds,
          allowed_updates: ["message", "channel_post", "my_chat_member"],
        },
        z.array(botUpdate),
        signal,
      );
      for (const next of updates) {
        if (stopped()) return;
        const start = startOf(next, bot);
        try {
          await (start === undefined ? intake(next) : link(start));
        } catch (error) {
          if (!(await pingDatabase().then(() => true, () => false))) throw error;
          attempts = failedId === next.update_id ? attempts + 1 : 1;
          failedId = next.update_id;
          if (attempts < attemptsPerUpdate) throw error;
          // The id and the reason only: the message's text is the user's.
          process.stderr.write(
            `Skipped Telegram update ${String(next.update_id)} after ${String(attempts)} failed attempts: ${messageOf(error)}\n`,
          );
          // A failed link spent nothing, so the same code still works until it expires.
          if (start !== undefined) {
            await reply(start.chat.id, "Watchdog couldn't link this chat. Try the same link again.", false);
          }
        }
        offset = next.update_id + 1;
      }
    } catch (error) {
      if (stopped()) return;
      process.stderr.write(`The Telegram bot's loop failed: ${messageOf(error)}\n`);
      await sleep(retryMs, undefined, { signal }).catch(() => undefined);
    }
  }
}
