import { describe, expect, it } from "vitest";
import type { BotMessage } from "../../telegram/update.ts";
import { telegramDraft } from "./draft.ts";

const supergroup = { id: -1001234567890, type: "supergroup", title: "Ops room" };
const message = (fields: object, chat: BotMessage["chat"] = supergroup): BotMessage => ({
  message_id: 77,
  date: 1_700_000_000,
  chat,
  from: { id: 5, is_bot: false, first_name: "Ada", last_name: "Lovelace" },
  ...fields,
});

describe("a Telegram message as a draft", () => {
  it("makes a text message into a draft, linked through t.me/c in a private supergroup", () => {
    const sent = message({ text: "Deploy failed\n\non   the   main  branch" });

    expect(telegramDraft(sent)).toEqual({
      externalId: "-1001234567890:77",
      url: "https://t.me/c/1234567890/77",
      title: "Deploy failed",
      author: "Ada Lovelace",
      body: "Deploy failed\n\non the main branch",
      publishedAt: new Date(1_700_000_000_000),
      raw: sent,
    });
  });

  it("links a public chat by its username", () => {
    const draft = telegramDraft(message({ text: "hi" }, { ...supergroup, username: "opsroom" }));

    expect(draft?.url).toBe("https://t.me/opsroom/77");
  });

  it("gives a basic group's message no link, since Telegram has none for it", () => {
    const draft = telegramDraft(message({ text: "hi" }, { id: -4001, type: "group", title: "Team" }));

    expect(draft?.url).toBeNull();
  });

  it("takes a photo's caption as the text", () => {
    const draft = telegramDraft(message({ photo: [{ file_id: "a" }], caption: "The new dashboard" }));

    expect(draft).toMatchObject({ title: "The new dashboard", body: "The new dashboard" });
  });

  it("names a channel post by its signature", () => {
    const post = { message_id: 3, date: 1_700_000_000, chat: { id: -1009, type: "channel", title: "News" } };

    expect(telegramDraft({ ...post, text: "Out now", author_signature: "Grace" })?.author).toBe("Grace");
    expect(telegramDraft({ ...post, text: "Out now" })?.author).toBeNull();
  });

  it("cuts the title at 200 characters, never inside an emoji", () => {
    expect(telegramDraft(message({ text: "x".repeat(300) }))?.title).toHaveLength(200);
    expect(telegramDraft(message({ text: `${"x".repeat(199)}🚀🚀` }))?.title).toBe(`${"x".repeat(199)}🚀`);
  });

  it("keeps a message that only starts like a command", () => {
    expect(telegramDraft(message({ text: "/r/selfhosted has a thread on this" }))?.title).toBe(
      "/r/selfhosted has a thread on this",
    );
  });

  it.each([
    ["a sticker", { sticker: { file_id: "s" } }],
    ["a photo without a caption", { photo: [{ file_id: "a" }] }],
    ["a service message", { new_chat_members: [{ id: 9 }] }],
    ["a blank text", { text: "  \n " }],
    ["a command to the bot", { text: "/start@WatchdogBot abc" }],
    ["any other command", { text: "/help" }],
    ["a command with words after it", { text: "/poll Which day?" }],
  ])("skips %s", (_name, fields) => {
    expect(telegramDraft(message(fields))).toBeUndefined();
  });
});
