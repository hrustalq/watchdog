import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type BotChat, runBot } from "./bot-runner.ts";
import type { BotUpdate } from "./update.ts";

const botToken = "123456:secret-token";
const requestBody = z.looseObject({
  offset: z.number().optional(),
  chat_id: z.number().optional(),
  text: z.string().optional(),
});

const startMessage = (updateId: number, text: string, chat: object = { id: 42, type: "private" }) => ({
  update_id: updateId,
  message: { message_id: updateId, date: 1_700_000_000, text, chat },
});

const linked = (name: string) => Promise.resolve(`Linked to ${name} in Watchdog`);

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
  linkChat: (code: string, chat: BotChat) => Promise<string> = () => Promise.resolve("That code is unknown"),
  pingDatabase: () => Promise<unknown> = () => Promise.resolve(),
  intake: (update: BotUpdate) => Promise<unknown> = () => Promise.resolve(),
) {
  return runBot({ botToken, fetch: telegram.fetch, linkChat, intake, pingDatabase, retryMs: 1 }, telegram.signal);
}

describe("the Telegram bot runner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("links the chat for a code and replies with what linking said", async () => {
    const telegram = fakeTelegram([[startMessage(10, "/start abc")]]);
    const linkChat = vi.fn(() => linked("Ops alerts"));

    await run(telegram, linkChat);

    expect(linkChat).toHaveBeenCalledExactlyOnceWith("abc", { id: "42", title: "Private chat", type: "private" });
    expect(telegram.replies()).toMatchObject([{ chat_id: 42, text: "Linked to Ops alerts in Watchdog" }]);
  });

  it("asks for the updates that intake reads", async () => {
    const telegram = fakeTelegram([]);

    await run(telegram);

    expect(telegram.polls()[0]?.allowed_updates).toEqual(["message", "channel_post", "my_chat_member"]);
  });

  it("takes a code posted in a channel", async () => {
    const channel = { id: -100300, type: "channel", title: "News" };
    const post = { message_id: 1, date: 1_700_000_000, text: "/start@WatchdogBot abc", chat: channel };
    const telegram = fakeTelegram([[{ update_id: 10, channel_post: post }]]);
    const linkChat = vi.fn(() => linked("News"));
    const intake = vi.fn(() => Promise.resolve());

    await run(telegram, linkChat, undefined, intake);

    expect(linkChat).toHaveBeenCalledExactlyOnceWith("abc", { id: "-100300", title: "News", type: "channel" });
    expect(intake).not.toHaveBeenCalled();
  });

  it("hands every update but a code to intake", async () => {
    const group = { id: -100200, type: "supergroup", title: "Ops room" };
    const member = { chat: group, new_chat_member: { status: "left" } };
    const updates = [
      startMessage(10, "Deploy failed", group),
      { update_id: 11, channel_post: { message_id: 2, date: 1_700_000_000, chat: group, caption: "A photo" } },
      { update_id: 12, my_chat_member: member },
      startMessage(13, "/start abc", group),
    ];
    const telegram = fakeTelegram([updates]);
    const intake = vi.fn<(update: BotUpdate) => Promise<void>>(() => Promise.resolve());

    await run(telegram, () => linked("Ops"), undefined, intake);

    expect(intake.mock.calls.map(([update]) => update.update_id)).toEqual([10, 11, 12]);
    expect(intake.mock.calls[0]?.[0].message).toMatchObject({ text: "Deploy failed", chat: group });
    expect(intake.mock.calls[2]?.[0].my_chat_member).toMatchObject(member);
  });

  it("skips an update whose intake keeps failing, and hands on the one behind it (#242)", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const batch = [startMessage(10, "breaks", { id: -5, type: "group" }), startMessage(11, "fine", { id: -5, type: "group" })];
    const telegram = fakeTelegram([batch, batch, batch]);
    const intake = vi.fn((update: BotUpdate) =>
      update.update_id === 10 ? Promise.reject(new Error("a bad row")) : Promise.resolve(),
    );

    await run(telegram, undefined, undefined, intake);

    expect(intake.mock.calls.map(([update]) => update.update_id)).toEqual([10, 10, 10, 11]);
    expect(telegram.polls().at(-1)?.offset).toBe(12);
    // A message that isn't a code gets no reply, skipped or not.
    expect(telegram.replies()).toEqual([]);
  });

  it("names a group by its title, and takes the command addressed to this bot in any case", async () => {
    const group = { id: -100200, type: "supergroup", title: "Ops room" };
    const telegram = fakeTelegram([[startMessage(10, "/start@watchdogBOT abc", group)]]);
    const linkChat = vi.fn(() => linked("Ops alerts"));

    await run(telegram, linkChat);

    expect(linkChat).toHaveBeenCalledExactlyOnceWith("abc", { id: "-100200", title: "Ops room", type: "supergroup" });
    expect(telegram.replies()).toMatchObject([{ chat_id: -100200 }]);
  });

  it.each([
    ["a message", "hello"],
    ["/start with no code", "/start"],
    ["a command for another bot", "/start@OtherBot abc"],
    ["more than a code", "/start abc def"],
    ["a command in the middle of a message", "see /start abc"],
  ])("doesn't take %s as a code", async (_name, text) => {
    const telegram = fakeTelegram([[startMessage(10, text)]]);
    const linkChat = vi.fn(() => linked("Ops alerts"));

    await run(telegram, linkChat);

    expect(linkChat).not.toHaveBeenCalled();
    expect(telegram.replies()).toEqual([]);
  });

  it("passes an update it can't read, and still moves past it", async () => {
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

  it("stops between the updates of a batch once it's told to", async () => {
    const telegram = fakeTelegram([[startMessage(10, "/start one"), startMessage(11, "/start two")]]);
    const stopping = new AbortController();
    const linkChat = vi.fn(() => {
      stopping.abort();
      return linked("Ops alerts");
    });

    await runBot(
      { botToken, fetch: telegram.fetch, linkChat, intake: () => Promise.resolve(), pingDatabase: () => Promise.resolve(), retryMs: 1 },
      stopping.signal,
    );

    expect(linkChat).toHaveBeenCalledOnce();
  });

  it("keeps a link whose reply failed, and moves on", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const telegram = fakeTelegram([[startMessage(10, "/start abc")]], {
      sendMessage: () => Response.json({ ok: false, description: "Forbidden" }, { status: 403 }),
    });
    const linkChat = vi.fn(() => linked("Ops alerts"));

    await run(telegram, linkChat);

    expect(linkChat).toHaveBeenCalledOnce();
    expect(telegram.polls().at(-1)?.offset).toBe(11);
  });

  it("reads an update again when linking it failed, so a database outage loses no code", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const telegram = fakeTelegram([[startMessage(10, "/start abc")], [startMessage(10, "/start abc")]]);
    const linkChat = vi
      .fn<(code: string, chat: BotChat) => Promise<string>>()
      .mockRejectedValueOnce(new Error("the database went away"))
      .mockResolvedValue("Linked to Ops alerts in Watchdog");

    await run(telegram, linkChat);

    expect(telegram.polls().map(({ offset }) => offset)).toEqual([undefined, undefined, 11]);
    expect(telegram.replies()).toHaveLength(1);
    expect(stderr.mock.calls.join()).toContain("the database went away");
  });

  it("skips an update that fails 3 times while the database answers, and handles the one behind it", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const batch = [startMessage(10, "/start broken"), startMessage(11, "/start abc", { id: 7, type: "private" })];
    const telegram = fakeTelegram([batch, batch, batch]);
    const linkChat = vi.fn((code: string) =>
      code === "broken" ? Promise.reject(new Error("a bad row")) : linked("Ops alerts"),
    );

    await run(telegram, linkChat);

    expect(linkChat.mock.calls.map(([code]) => code)).toEqual(["broken", "broken", "broken", "abc"]);
    expect(telegram.polls().map(({ offset }) => offset)).toEqual([undefined, undefined, undefined, 12]);
    expect(telegram.replies()).toMatchObject([{ chat_id: 42 }, { chat_id: 7, text: "Linked to Ops alerts in Watchdog" }]);
  });

  it("never skips an update while the database can't be reached", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const batch = [startMessage(10, "/start abc")];
    const telegram = fakeTelegram([batch, batch, batch, batch, batch]);
    const linkChat = vi.fn(() => Promise.reject(new Error("connection refused")));

    await run(telegram, linkChat, () => Promise.reject(new Error("connection refused")));

    expect(linkChat).toHaveBeenCalledTimes(5);
    expect(telegram.polls().every(({ offset }) => offset === undefined)).toBe(true);
    expect(telegram.replies()).toEqual([]);
  });

  it("never skips an update when the database takes too long to answer", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const batch = [startMessage(10, "/start abc")];
    const telegram = fakeTelegram([batch, batch, batch, batch]);
    const timedOut = () => Promise.reject(new Error("Connection terminated due to connection timeout"));
    const linkChat = vi.fn(timedOut);

    // The pool's connect limit rejects the ping, so the runner waits and reads the same update again.
    await run(telegram, linkChat, timedOut);

    expect(linkChat).toHaveBeenCalledTimes(4);
    expect(telegram.polls().every(({ offset }) => offset === undefined)).toBe(true);
    expect(telegram.replies()).toEqual([]);
  });

  it("asks a skipped chat once to try again, and its code still links afterwards", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const start = startMessage(10, "/start abc");
    const telegram = fakeTelegram([[start], [start], [start], [startMessage(11, "/start abc")]]);
    const linkChat = vi
      .fn<(code: string, chat: BotChat) => Promise<string>>()
      .mockRejectedValueOnce(new Error("a bad row"))
      .mockRejectedValueOnce(new Error("a bad row"))
      .mockRejectedValueOnce(new Error("a bad row"))
      .mockResolvedValue("Linked to Ops alerts in Watchdog");

    await run(telegram, linkChat);

    expect(telegram.replies().map(({ text }) => text)).toEqual([
      "Watchdog couldn't link this chat. Try the same link again.",
      "Linked to Ops alerts in Watchdog",
    ]);
    expect(linkChat).toHaveBeenLastCalledWith("abc", { id: "42", title: "Private chat", type: "private" });
  });

  it("logs which update it skipped and why, without the message's text or the bot's token", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const start = startMessage(10, "/start s3cret-code");
    const telegram = fakeTelegram([[start], [start], [start]]);

    await run(telegram, () => Promise.reject(new Error("a bad row")));

    const logged = stderr.mock.calls.join();
    expect(logged).toContain("Skipped Telegram update 10 after 3 failed attempts: a bad row");
    expect(logged).not.toContain("s3cret-code");
    expect(logged).not.toContain(botToken);
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
