// Every call a Telegram user session makes goes through here (docs: Security and privacy, "Telegram
// user sessions"): the methods that read pass, and anything else throws before it reaches Telegram.
// It also waits out Telegram's FLOOD_WAIT before the next call, rather than calling again at once.
import { setTimeout as sleep } from "node:timers/promises";
import { type ITelegramClient, tl } from "@mtcute/node";

/**
 * `get…` methods read. A few act for the user even so: counting a view, pressing a bot's button,
 * querying an inline bot, and sharing the user's location with people nearby.
 */
const acts = new Set(["messages.getMessagesViews", "messages.getBotCallbackAnswer", "messages.getInlineBotResults", "contacts.getLocated"]);
const reads = (method: string) => (/^\w+\.get/.test(method) && !acts.has(method)) || method === "contacts.resolveUsername";

/** A FLOOD_WAIT that lasts past the turn's end, which then ends so the next turn starts after it. */
export class FloodWaitTooLong extends Error {
  readonly until: Date;
  constructor(until: Date) {
    super(`Telegram asked to wait until ${until.toISOString()}`);
    this.until = until;
  }
}

/**
 * Wraps the client in place, so the calls mtcute makes on its own (updates, resolving peers) are
 * checked too. `also` adds methods for one job: the login's own, or the revoke's `auth.logOut`.
 */
export function readOnly(client: ITelegramClient, also: string[] = [], { until, signal }: { until?: Date; signal?: AbortSignal } = {}) {
  const call = client.call.bind(client);
  let waitUntil = 0;
  client.call = async (message, params) => {
    const method = message._;
    if (!reads(method) && !also.includes(method)) throw new Error(`${method} isn't a read method, so Watchdog refuses to call it`);
    if (until !== undefined && waitUntil > until.getTime()) throw new FloodWaitTooLong(new Date(waitUntil));
    const wait = waitUntil - Date.now();
    if (wait > 0) await sleep(wait, undefined, { signal });
    try {
      return await call(message, params);
    } catch (error) {
      if (!tl.RpcError.is(error, "FLOOD_WAIT_%d")) throw error;
      waitUntil = Date.now() + error.seconds * 1000;
      throw until !== undefined && waitUntil > until.getTime() ? new FloodWaitTooLong(new Date(waitUntil)) : error;
    }
  };
  return client;
}
