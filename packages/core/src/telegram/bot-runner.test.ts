import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type BotChat, runBot } from "./bot-runner.ts";

const botToken = "123456:secret-token";
const requestBody = z.looseObject({
  offset: z.number().optional(),
  chat_id: z.number().optional(),
  text: z.string().optional(),
});

const startMessage = (updateId: number, text: string, chat: object = { id: 42, type: "private" }) => ({
  update_id: updateId,
  message: { message_id: updateId, text, chat },
});

/**
 * A fake Bot API. Each getUpdates takes the next batch, and once they run out it stops the runner the way
 * a shutdown does, by aborting the signal during a poll.
 */
function fakeTelegram(batches: unknown[][], answers: Partial<Record<string, () => Response>> = {}) {
  const sent: { method: string; body: z.output<typeof requestBody> }[] = [];
  const stopping = new AbortController();
  const fetch: Parameters<typeof runBot>[0]["fetch"] = (input, init) => {
    const method = String(input).split("/").at(-1) ?? "";
    const body = requestBody.parse(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
    sent.push({ method, body });
    const answer = answers[method];
    if (answer !== undefined) return Promise.resolve(answer());
    if (method === "getMe") return Promise.resolve(Response.json({ ok: true, result: { username: "WatchdogBot" } }));
    if (method === "sendMessage") return Promise.resolve(Response.json({ ok: true, result: {} }));
    const batch = batches.shift();
    if (batch !== undefined) return Promise.resolve(Response.json({ ok: true, result: batch }));
    stopping.abort();
    // A runner that didn't pass its signal to the poll would wait here, and the test would time out.
    return init?.signal?.aborted === true
      ? Promise.reject(new DOMException("stopped", "AbortError"))
      : new Promise(() => undefined);
  };
  return {
    sent,
    fetch,
    signal: stopping.signal,
    replies: () => sent.filter(({ method }) => method === "sendMessage").map(({ body }) => body),
    polls: () => sent.filter(({ method }) => method === "getUpdates").map(({ body }) => body),
  };
}

function run(
  telegram: ReturnType<typeof fakeTelegram>,
  linkChat: (code: string, chat: BotChat) => Promise<string | undefined> = () => Promise.resolve(undefined),
) {
  return runBot({ botToken, fetch: telegram.fetch, linkChat, retryMs: 1 }, telegram.signal);
}

describe("the Telegram bot runner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("links the chat for a valid code and replies with the Destination's name", async () => {
    const telegram = fakeTelegram([[startMessage(10, "/start abc")]]);
    const linkChat = vi.fn(() => Promise.resolve("Ops alerts"));

    await run(telegram, linkChat);

    expect(linkChat).toHaveBeenCalledExactlyOnceWith("abc", { id: "42", title: "Private chat" });
    expect(telegram.replies()).toMatchObject([{ chat_id: 42, text: "Linked to Ops alerts in Watchdog" }]);
  });

  it("says so when the code is unknown or expired, for either of which linkChat finds nothing", async () => {
    const telegram = fakeTelegram([[startMessage(10, "/start stale")]]);

    await run(telegram);

    expect(telegram.replies()).toHaveLength(1);
    expect(telegram.replies()[0]?.text).toMatch(/unknown or has expired/);
  });

  it("names a group by its title, and takes the command addressed to this bot in any case", async () => {
    const group = { id: -100200, type: "supergroup", title: "Ops room" };
    const telegram = fakeTelegram([[startMessage(10, "/start@watchdogBOT abc", group)]]);
    const linkChat = vi.fn(() => Promise.resolve("Ops alerts"));

    await run(telegram, linkChat);

    expect(linkChat).toHaveBeenCalledExactlyOnceWith("abc", { id: "-100200", title: "Ops room" });
    expect(telegram.replies()).toMatchObject([{ chat_id: -100200 }]);
  });

  it.each([
    ["a message", "hello"],
    ["/start with no code", "/start"],
    ["a command for another bot", "/start@OtherBot abc"],
    ["more than a code", "/start abc def"],
    ["a command in the middle of a message", "see /start abc"],
  ])("ignores %s", async (_name, text) => {
    const telegram = fakeTelegram([[startMessage(10, text)]]);
    const linkChat = vi.fn(() => Promise.resolve("Ops alerts"));

    await run(telegram, linkChat);

    expect(linkChat).not.toHaveBeenCalled();
    expect(telegram.replies()).toEqual([]);
  });

  it("ignores an update that isn't a text message, and still moves past it", async () => {
    const telegram = fakeTelegram([
      [{ update_id: 10, message: { message_id: 1, chat: { id: 42 }, photo: [] } }, { update_id: 11, poll: {} }],
    ]);

    await run(telegram);

    expect(telegram.replies()).toEqual([]);
    expect(telegram.polls().at(-1)?.offset).toBe(12);
  });

  it("confirms each batch through the next poll's offset, and reads the bot's name once", async () => {
    const telegram = fakeTelegram([[startMessage(10, "hi"), startMessage(11, "hi")], [startMessage(12, "hi")]]);

    await run(telegram);

    expect(telegram.polls().map(({ offset }) => offset)).toEqual([undefined, 12, 13]);
    expect(telegram.sent.filter(({ method }) => method === "getMe")).toHaveLength(1);
  });

  it("keeps a link whose reply failed, and moves on", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const telegram = fakeTelegram([[startMessage(10, "/start abc")]], {
      sendMessage: () => Response.json({ ok: false, description: "Forbidden" }, { status: 403 }),
    });
    const linkChat = vi.fn(() => Promise.resolve("Ops alerts"));

    await run(telegram, linkChat);

    expect(linkChat).toHaveBeenCalledOnce();
    expect(telegram.polls().at(-1)?.offset).toBe(11);
  });

  it("reads an update again when linking it failed, so a database outage loses no code", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const telegram = fakeTelegram([[startMessage(10, "/start abc")], [startMessage(10, "/start abc")]]);
    const linkChat = vi
      .fn<(code: string, chat: BotChat) => Promise<string | undefined>>()
      .mockRejectedValueOnce(new Error("the database went away"))
      .mockResolvedValue("Ops alerts");

    await run(telegram, linkChat);

    expect(telegram.polls().map(({ offset }) => offset)).toEqual([undefined, undefined, 11]);
    expect(telegram.replies()).toHaveLength(1);
    expect(stderr.mock.calls.join()).toContain("the database went away");
  });

  it("keeps trying after Telegram refuses, without the bot's token in the log", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    let refusals = 1;
    const telegram = fakeTelegram([], {
      getMe: () => {
        refusals -= 1;
        return refusals >= 0
          ? Response.json({ ok: false, description: "Unauthorized" }, { status: 401 })
          : Response.json({ ok: true, result: { username: "WatchdogBot" } });
      },
    });

    await run(telegram);

    expect(telegram.polls()).toHaveLength(1);
    const logged = stderr.mock.calls.join();
    expect(logged).toContain("Unauthorized");
    expect(logged).not.toContain(botToken);
  });

  it("stops without logging when its signal ends a poll", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await run(fakeTelegram([]));

    expect(stderr).not.toHaveBeenCalled();
  });
});
