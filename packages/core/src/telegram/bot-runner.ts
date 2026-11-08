// The Telegram bot's one getUpdates loop, which links chats to Destinations (docs: Actions and delivery,
// "Telegram chats"; ADR 0029). It handles `/start <code>` and ignores the rest. M4 widens it into intake.
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { botApiUrl, refusal } from "../delivery/telegram.ts";
import { unreachable } from "../delivery/deliver.ts";
import type { createEgressFetch } from "../egress/egress.ts";

type BotFetch = ReturnType<typeof createEgressFetch>;

/** Under the egress guard's 30 seconds, so a quiet poll ends before the guard calls it too slow. */
const pollSeconds = 25;

const update = z.object({
  update_id: z.number(),
  // Anything else Telegram can send, such as a photo, isn't for the runner, and the loop still has to pass it.
  message: z
    .object({ text: z.string(), chat: z.object({ id: z.number(), title: z.string().optional() }) })
    .optional()
    .catch(undefined),
});

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
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Reads the bot's updates until the signal ends. An update counts as read only once it's handled, because
 * Telegram resends everything from the offset of the last poll on. So a failure, logged here, tries again
 * after `retryMs`, and a stop in the middle of a batch can bring a `/start` back with a reply that the code is gone.
 * An update that fails `attemptsPerUpdate` times while the database answers is skipped, so it can't hold up
 * the ones behind it. While the database is down every update waits, so an outage loses no `/start`.
 */
export async function runBot(
  deps: {
    botToken: string;
    fetch: BotFetch;
    /** Spends a code on a chat, and gives the Destination's name, or undefined for an unknown or expired code. */
    linkChat: (code: string, chat: BotChat) => Promise<string | undefined>;
    /** Rejects when the database can't be reached. */
    pingDatabase: () => Promise<unknown>;
    retryMs?: number;
  },
  signal: AbortSignal,
) {
  const { linkChat, pingDatabase, retryMs = 15_000 } = deps;
  let username: string | undefined;
  let offset: number | undefined;
  let failedId: number | undefined;
  let attempts = 0;

  const reply = async (chatId: number, text: string) => {
    // A chat that can't be answered, such as one that blocked the bot, must not hold up everyone else's.
    await callBot(deps, "sendMessage", { chat_id: chatId, text, link_preview_options: { is_disabled: true } }, z.unknown()).catch(
      (error: unknown) => {
        process.stderr.write(`Replying in a Telegram chat failed: ${messageOf(error)}\n`);
      },
    );
  };

  const startOf = ({ message }: z.output<typeof update>, bot: string) => {
    const [, addressedTo, code] = startCommand.exec(message?.text ?? "") ?? [];
    if (message === undefined || code === undefined) return undefined;
    if (addressedTo !== undefined && addressedTo.toLowerCase() !== bot.toLowerCase()) return undefined;
    return { code, chat: message.chat };
  };

  const handle = async (next: z.output<typeof update>, bot: string) => {
    const start = startOf(next, bot);
    if (start === undefined) return;
    const { id, title = "Private chat" } = start.chat;
    const name = await linkChat(start.code, { id: String(id), title });
    await reply(
      id,
      name === undefined
        ? "That code is unknown or has expired. Get a new link on the Destinations page in Watchdog."
        : `Linked to ${name} in Watchdog`,
    );
  };

  // A function, because TypeScript would otherwise take `aborted` as still false inside the loop.
  const stopped = () => signal.aborted;
  while (!stopped()) {
    try {
      const bot = (username ??= await botUsername(deps.botToken, deps.fetch, signal));
      const updates = await callBot(
        deps,
        "getUpdates",
        { ...(offset !== undefined && { offset }), timeout: pollSeconds, allowed_updates: ["message"] },
        z.array(update),
        signal,
      );
      for (const next of updates) {
        if (stopped()) return;
        try {
          await handle(next, bot);
        } catch (error) {
          if (!(await pingDatabase().then(() => true, () => false))) throw error;
          attempts = failedId === next.update_id ? attempts + 1 : 1;
          failedId = next.update_id;
          if (attempts < attemptsPerUpdate) throw error;
          // The id and the reason only: the message's text is the user's.
          const id = String(next.update_id);
          process.stderr.write(`Skipped Telegram update ${id} after ${String(attempts)} failed attempts: ${messageOf(error)}\n`);
          // A failed link spent nothing, so the same code still works until it expires.
          const chatId = startOf(next, bot)?.chat.id;
          if (chatId !== undefined) await reply(chatId, "Watchdog couldn't link this chat. Try the same link again.");
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
