import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EgressLimitError } from "../egress/egress.ts";
import { decryptSecret, encryptSecret } from "../secrets/secrets.ts";
import type { AlertMessage } from "./content.ts";
import { type Destination, FinalSendError, NotYetSendError, RetryAfterSendError } from "./deliver.ts";
import { groupedAlert } from "./group.ts";
import { sourceAlertContent } from "./source-alert-content.ts";
import { createTelegramSender } from "./telegram.ts";

const encryptionKey = Buffer.alloc(32, 7);
const botToken = "123456:secret-token";
const link = "https://watchdog.test/items/0a1b";

const message: AlertMessage = {
  title: "A security advisory",
  source: "Hacker News",
  rating: "Severity 5, Importance 3",
  severity: 5,
  summary: "Patch now.",
  link,
  why: "Severity is at least 4",
};

const group = (count: number, title = "An advisory") =>
  groupedAlert(
    Array.from({ length: count }, (_, index) => ({ id: String(index), title, severity: 4, importance: 3 })),
    "https://watchdog.test",
  );

const unlinked: Destination = {
  id: "0a1b",
  workspaceId: "0a1c",
  type: "telegram",
  name: "ops-chat",
  config: {},
  secretCiphertext: null,
  secretShownAt: null,
  confirmedAt: null,
  lastError: null,
  lastErrorAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const chat = (chatId = "-100200"): Destination => ({
  ...unlinked,
  secretCiphertext: encryptSecret(chatId, encryptionKey),
});

const requestBody = z.looseObject({ chat_id: z.string(), text: z.string() });

/** A fake Telegram API that records each request and when it arrived. */
function fakeTelegram(answer: () => Response = () => Response.json({ ok: true, result: {} })) {
  const requests: { url: string; body: z.output<typeof requestBody>; at: number }[] = [];
  const fetch: Parameters<typeof createTelegramSender>[1]["fetch"] = (input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push({ url: String(input), body: requestBody.parse(JSON.parse(body)), at: Date.now() });
    return Promise.resolve(answer());
  };
  return { requests, fetch };
}

const sender = (telegram: ReturnType<typeof fakeTelegram>, token: string | undefined = botToken) =>
  createTelegramSender(token, { fetch: telegram.fetch, encryptionKey });

const textOf = (telegram: ReturnType<typeof fakeTelegram>) => telegram.requests[0]?.body.text ?? "";

/** The value, which the test expects to be there. */
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}

/** The error a send rejects with, which the test expects it to. */
async function failureOf(send: Promise<void>) {
  try {
    await send;
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("Expected the send to fail");
}

/** The not-yet a send rejects with, which the test expects. */
function notYetOf(error: Error): NotYetSendError {
  if (error instanceof NotYetSendError) return error;
  throw new Error(`Expected a not-yet send, got ${error.name}`);
}

/** What Telegram answers when it refuses a request. */
const refusal = (status: number, description: string, parameters?: object) =>
  Response.json({ ok: false, error_code: status, description, parameters }, { status });

describe("createTelegramSender", () => {
  it("posts the whole alert to the bound chat through the bot's URL", async () => {
    const telegram = fakeTelegram();

    await sender(telegram).send(chat(), message);

    const [request] = telegram.requests;
    expect(request?.url).toBe(`https://api.telegram.org/bot${botToken}/sendMessage`);
    expect(request?.body.chat_id).toBe("-100200");
    for (const part of [message.title, message.source, message.rating, "Patch now.", message.why, link]) {
      expect(request?.body.text).toContain(part);
    }
  });

  it("leaves out the summary of an Item that has none", async () => {
    const telegram = fakeTelegram();

    await sender(telegram).send(chat(), { ...message, summary: null });

    expect(textOf(telegram)).not.toContain("null");
    expect(textOf(telegram).endsWith(`\n\n${link}`)).toBe(true);
  });

  it("sends untrusted Item text as plain text, with no link preview to fetch", async () => {
    const telegram = fakeTelegram();
    const title = "<b>*bold*</b> [click](https://evil.test)";

    await sender(telegram).send(chat(), { ...message, title });

    const body = telegram.requests[0]?.body;
    expect(body).not.toHaveProperty("parse_mode");
    expect(body?.text).toContain(title);
    expect(body?.link_preview_options).toEqual({ is_disabled: true });
  });

  it("cuts a long message with an ellipsis before the link, at Telegram's limit", async () => {
    const telegram = fakeTelegram();

    await sender(telegram).send(chat(), { ...message, summary: "x".repeat(5000) });

    const text = textOf(telegram);
    expect(text).toHaveLength(4096);
    expect(text.endsWith(`x…\n\n${link}`)).toBe(true);
  });

  it("leaves a message at the limit whole", async () => {
    const whole = fakeTelegram();
    await sender(whole).send(chat(), { ...message, summary: "" });
    const room = 4096 - textOf(whole).length;
    const telegram = fakeTelegram();

    await sender(telegram).send(chat(), { ...message, summary: "x".repeat(room - 2) });

    expect(textOf(telegram)).toHaveLength(4096);
    expect(textOf(telegram)).not.toContain("…");
  });

  it("doesn't split a character made of two UTF-16 units at the cut", async () => {
    for (const padding of ["", "x"]) {
      const telegram = fakeTelegram();

      await sender(telegram).send(chat(), { ...message, summary: padding + "🚨".repeat(3000) });

      expect(textOf(telegram).isWellFormed()).toBe(true);
      expect(textOf(telegram).length).toBeLessThanOrEqual(4096);
    }
  });

  it("sends a Grouped alert as one message listing each Item", async () => {
    const telegram = fakeTelegram();

    await sender(telegram).send(chat(), group(25));

    expect(telegram.requests).toHaveLength(1);
    const lines = textOf(telegram).split("\n");
    expect(lines[0]).toBe("25 alerts");
    expect(lines.slice(1).filter((line) => line.includes("An advisory"))).toHaveLength(25);
  });

  it("cuts a Grouped alert at Telegram's limit, and links to the Feed for the rest", async () => {
    const telegram = fakeTelegram();

    await sender(telegram).send(chat(), group(50, "x".repeat(200)));

    const text = textOf(telegram);
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text.split("\n").at(-1)).toMatch(/^and \d+ more: https:\/\/watchdog\.test\/$/);
  });

  it("names how long to wait when Telegram answers 429 with retry_after", async () => {
    const telegram = fakeTelegram(() =>
      refusal(429, "Too Many Requests: retry after 5", { retry_after: 5 }),
    );

    const failure = await failureOf(sender(telegram).send(chat(), message));

    expect(failure).toBeInstanceOf(RetryAfterSendError);
    expect(failure).toMatchObject({ retryAfterMs: 5000 });
  });

  it("treats a 429 without retry_after as a plain failure", async () => {
    const telegram = fakeTelegram(() => refusal(429, "Too Many Requests"));

    const failure = await failureOf(sender(telegram).send(chat(), message));

    expect(failure).not.toBeInstanceOf(RetryAfterSendError);
    expect(failure).not.toBeInstanceOf(FinalSendError);
  });

  it("fails for good, saying the bot was removed, when Telegram answers 403", async () => {
    const telegram = fakeTelegram(() => refusal(403, "Forbidden: bot was kicked from the group chat"));

    const failure = await failureOf(sender(telegram).send(chat(), message));

    expect(failure).toBeInstanceOf(FinalSendError);
    expect(failure.message).toMatch(/bot was removed from the chat/);
    expect(failure.message).toContain("Forbidden: bot was kicked from the group chat");
  });

  it("gives Telegram's reason for any other refusal, as a plain failure", async () => {
    const telegram = fakeTelegram(() => refusal(400, "Bad Request: chat not found"));

    const failure = await failureOf(sender(telegram).send(chat(), message));

    expect(failure).not.toBeInstanceOf(FinalSendError);
    expect(failure.message).toContain("Bad Request: chat not found");
    expect(failure.message).toContain("400");
  });

  describe("a chat that moved to a supergroup", () => {
    const moved = () =>
      refusal(400, "Bad Request: group chat was upgraded to a supergroup chat", { migrate_to_chat_id: -1009876543210 });
    /** Telegram refusing the old chat, then taking the message at the new one. */
    const movedThenSent = () => {
      const answers = [moved(), Response.json({ ok: true, result: {} })];
      return fakeTelegram(() => answers.shift() ?? Response.error());
    };
    const chatIds = (telegram: ReturnType<typeof fakeTelegram>) => telegram.requests.map(({ body }) => body.chat_id);

    it("sends again at once to the new chat, and hands over the new id encrypted", async () => {
      const telegram = movedThenSent();
      const stored: string[] = [];

      await sender(telegram).send(chat(), message, (secretCiphertext) => {
        stored.push(secretCiphertext);
        return Promise.resolve();
      });

      expect(chatIds(telegram)).toEqual(["-100200", "-1009876543210"]);
      expect(stored).toHaveLength(1);
      expect(stored[0]).not.toContain("9876543210");
      expect(decryptSecret(present(stored[0]), encryptionKey)).toBe("-1009876543210");
    });

    it("sends only once more, and fails as a plain refusal, when the new chat refuses too", async () => {
      const telegram = fakeTelegram(moved);

      const failure = await failureOf(sender(telegram).send(chat(), message, () => Promise.resolve()));

      expect(telegram.requests).toHaveLength(2);
      expect(failure).not.toBeInstanceOf(FinalSendError);
      expect(failure.message).toContain("400");
    });

    it("keeps Telegram's reason, and sends nothing more, when the new id isn't a whole number", async () => {
      const telegram = fakeTelegram(() =>
        refusal(400, "Bad Request: group chat was upgraded to a supergroup chat", { migrate_to_chat_id: "soon" }),
      );

      const failure = await failureOf(sender(telegram).send(chat(), message));

      expect(telegram.requests).toHaveLength(1);
      expect(failure.message).toContain("group chat was upgraded");
    });

    it("still sends to the new chat when the caller keeps no chat id", async () => {
      const telegram = movedThenSent();

      await sender(telegram).send(chat(), message);

      expect(chatIds(telegram)).toEqual(["-100200", "-1009876543210"]);
    });
  });

  it("copes with an answer that isn't Telegram's JSON, and keeps the token out of the reason", async () => {
    const telegram = fakeTelegram(() => new Response("<html>Bad gateway</html>", { status: 502 }));

    const failure = await failureOf(sender(telegram).send(chat(), message));

    expect(failure.message).toContain("502");
    expect(failure.message).not.toContain(botToken);
  });

  it("says the chat isn't linked, and calls nothing, for a Destination with no chat", async () => {
    const telegram = fakeTelegram();

    await expect(sender(telegram).send(unlinked, message)).rejects.toThrow(/isn't linked/);

    expect(telegram.requests).toEqual([]);
  });

  it("counts a message as sent when the answer breaks off after the 200", async () => {
    const broken = new ReadableStream({
      start(controller) {
        controller.error(new Error("socket hang up"));
      },
    });
    const telegram = fakeTelegram(() => new Response(broken));

    await expect(sender(telegram).send(chat(), message)).resolves.toBeUndefined();
  });

  it.each([
    ["the cause", "getaddrinfo ENOTFOUND api.telegram.org", /^Telegram can't be reached: getaddrinfo ENOTFOUND api\.telegram\.org$/],
    ["no more when the cause has no message", "", /^Telegram can't be reached$/],
  ])("says Telegram can't be reached, with %s, on a network failure", async (_name, cause, reason) => {
    const fetch = () => Promise.reject(new TypeError("fetch failed", { cause: new Error(cause) }));

    const failure = await failureOf(createTelegramSender(botToken, { fetch, encryptionKey }).send(chat(), message));

    expect(failure.message).toMatch(reason);
    expect(failure).not.toBeInstanceOf(FinalSendError);
  });

  it("keeps the egress guard's own reason", async () => {
    const fetch = () => Promise.reject(new EgressLimitError("api.telegram.org took longer than 30000 ms"));

    const failure = await failureOf(createTelegramSender(botToken, { fetch, encryptionKey }).send(chat(), message));

    expect(failure.message).toBe("api.telegram.org took longer than 30000 ms");
  });

  it("says the bot isn't set up when there is no token, and calls nothing", async () => {
    const telegram = fakeTelegram();
    const noBot = createTelegramSender(undefined, { fetch: telegram.fetch, encryptionKey });

    await expect(noBot.send(chat(), message)).rejects.toThrow(/bot isn't set up/);

    expect(telegram.requests).toEqual([]);
  });

  describe("flood limits", () => {
    it("reaches Telegram no faster than 30 messages a second across the bot", async () => {
      const telegram = fakeTelegram();
      const bot = sender(telegram);

      await Promise.all(
        Array.from({ length: 31 }, (_, index) => bot.send(chat(String(index)), message)),
      );

      const arrivals = telegram.requests.map((request) => request.at).sort((a, b) => a - b);
      expect(arrivals).toHaveLength(31);
      expect(Number(arrivals[30]) - Number(arrivals[0])).toBeGreaterThanOrEqual(1000);
    });

    it("reaches one chat no faster than one message a second", async () => {
      const telegram = fakeTelegram();
      const bot = sender(telegram);

      await Promise.all([bot.send(chat(), message), bot.send(chat(), message)]);

      const [first, second] = telegram.requests;
      expect(Number(second?.at) - Number(first?.at)).toBeGreaterThanOrEqual(1000);
    });

    it("doesn't make a chat wait for another chat's second", async () => {
      const telegram = fakeTelegram();
      const bot = sender(telegram);

      await Promise.all([bot.send(chat("1"), message), bot.send(chat("2"), message)]);

      const [first, second] = telegram.requests;
      expect(Number(second?.at) - Number(first?.at)).toBeLessThan(500);
    });

    it("says when a chat's turn is, taking it for then, when the caller can resend", async () => {
      const telegram = fakeTelegram();
      const bot = sender(telegram);
      await bot.send(chat(), message);

      const failure = notYetOf(
        await failureOf(bot.send(chat(), message, undefined, { deferTurn: true })),
      );

      // A second, as one chat takes, and the turn is taken, so a send then waits for nothing.
      expect(failure.waitMs).toBeGreaterThanOrEqual(1000);
      expect(failure.waitMs).toBeLessThan(1500);
      expect(telegram.requests).toHaveLength(1);

      await new Promise((resolve) => setTimeout(resolve, failure.waitMs));
      await bot.send(chat(), message, undefined, { deferTurn: true });

      // The turn it booked, not a second one taken behind it.
      const [first, second] = telegram.requests;
      expect(Number(second?.at) - Number(first?.at)).toBeGreaterThanOrEqual(1000);
      expect(Number(second?.at) - Number(first?.at)).toBeLessThan(2000);
    });

    it("keeps a bot-wide turn that is a moment away, rather than make the caller resend", async () => {
      const telegram = fakeTelegram();
      const bot = sender(telegram);

      await Promise.all([
        bot.send(chat("1"), message, undefined, { deferTurn: true }),
        bot.send(chat("2"), message, undefined, { deferTurn: true }),
      ]);

      expect(telegram.requests).toHaveLength(2);
    });
  });

  it("sends a Source Health alert as its lines: the state, the last error, the Sources screen", async () => {
    const telegram = fakeTelegram();
    const failing = sourceAlertContent("failing", "Release\nfeed", "connect ECONNREFUSED", "https://watchdog.test");
    await sender(telegram).send(chat(), failing);
    await sender(telegram).send(chat(), sourceAlertContent("recovered", "Release feed", null, "https://watchdog.test"));

    expect(telegram.requests.map(({ body }) => body.text)).toEqual([
      "Source Release feed is failing\nconnect ECONNREFUSED\nhttps://watchdog.test/sources",
      "Source Release feed recovered\nhttps://watchdog.test/sources",
    ]);
  });

  it("cuts a Health alert's error so the message fits", async () => {
    const telegram = fakeTelegram();
    await sender(telegram).send(chat(), sourceAlertContent("failing", "Feed", "x".repeat(10_000), "https://watchdog.test"));
    expect(textOf(telegram)).toBe(`Source Feed is failing\n${"x".repeat(500)}\nhttps://watchdog.test/sources`);
  });
});
