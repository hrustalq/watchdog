import { randomBytes } from "node:crypto";
import { closeDb, createDb, type Db, eq, item, migrate, source, user, workspace } from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { runBot } from "../../telegram/bot-runner.ts";
import { issueLinkCode, linkChat } from "../../telegram/link.ts";
import { telegramIntake } from "./intake.ts";

const encryptionKey = randomBytes(32);
let nextChat = -1_001_000_000_000;

describe("Telegram bot intake", () => {
  let db: Db;
  const enqueued: string[] = [];

  beforeAll(async () => {
    const postgres = await startPostgres();
    await migrate(postgres.url);
    db = createDb(postgres.url);
    return async () => {
      await closeDb(db);
      await postgres.stop();
    };
  }, 120_000);

  /** A Workspace of its own owner, since a user has one. */
  async function newWorkspace() {
    const id = crypto.randomUUID();
    await db.insert(user).values({ id, name: "Owner", email: `${id}@example.com` });
    const [saved] = await db.insert(workspace).values({ name: "Workspace", ownerUserId: id }).returning();
    return saved?.id ?? "";
  }

  async function telegramSource(workspaceId: string) {
    const [row] = await db
      .insert(source)
      .values({ workspaceId, type: "telegram", name: "Ops chat", config: { via: "bot" }, schedule: null, nextPollAt: null })
      .returning();
    if (row === undefined) throw new Error("Nothing was saved");
    return row;
  }

  /** The bot reads these updates, one poll each, through the real runner and a fake Bot API. */
  async function botReads(...updates: object[]) {
    const stopping = new AbortController();
    const batches = updates.map((update, index) => [{ update_id: index + 1, ...update }]);
    await runBot(
      {
        botToken: "123456:secret-token",
        linkChat: (code, chat) => linkChat(db, encryptionKey, code, chat),
        intake: telegramIntake(db, {
          enqueueItems: (_tx, ids) => {
            enqueued.push(...ids);
            return Promise.resolve();
          },
        }),
        pingDatabase: () => db.$client.query("select 1"),
        retryMs: 1,
        fetch: (input) => {
          const method = String(input).split("/").at(-1);
          if (method === "getMe") return Promise.resolve(Response.json({ result: { username: "WatchdogBot" } }));
          if (method === "sendMessage") return Promise.resolve(Response.json({ result: {} }));
          const batch = batches.shift();
          if (batch !== undefined) return Promise.resolve(Response.json({ result: batch }));
          stopping.abort();
          return Promise.reject(new DOMException("stopped", "AbortError"));
        },
      },
      stopping.signal,
    );
  }

  const group = () => ({ id: (nextChat -= 1), type: "supergroup", title: "Ops room" });
  let messageId = 0;
  const message = (chat: object, fields: object) => ({
    message: { message_id: (messageId += 1), date: 1_700_000_000, chat, from: { first_name: "Ada" }, ...fields },
  });
  const itemsOf = (sourceId: string) => db.select().from(item).where(eq(item.sourceId, sourceId));
  const readSource = async (id: string) => db.query.source.findFirst({ where: eq(source.id, id) });

  /** A Source bound to a new group through its link, as a person would do it. */
  async function boundSource(workspaceId?: string, chat = group()) {
    const watching = await telegramSource(workspaceId ?? (await newWorkspace()));
    const code = await issueLinkCode(db, { sourceId: watching.id });
    await botReads(message(chat, { text: `/start@WatchdogBot ${code}` }));
    return { watching, chat };
  }

  it("captures a text message in the group as an Item once the group is bound through the link", async () => {
    const { watching, chat } = await boundSource();

    await botReads(message(chat, { text: "Deploy failed on main" }));

    const items = await itemsOf(watching.id);
    expect(items).toMatchObject([
      { workspaceId: watching.workspaceId, title: "Deploy failed on main", author: "Ada", externalId: `${String(chat.id)}:${String(messageId)}` },
    ]);
    expect(enqueued).toContain(items[0]?.id);
  });

  it("captures a photo with a caption, and not a sticker, a photo without one, or the code", async () => {
    const { watching, chat } = await boundSource();

    await botReads(
      message(chat, { photo: [{ file_id: "a" }], caption: "The new dashboard" }),
      message(chat, { sticker: { file_id: "s" } }),
      message(chat, { photo: [{ file_id: "b" }] }),
    );

    expect((await itemsOf(watching.id)).map(({ title }) => title)).toEqual(["The new dashboard"]);
  });

  it("captures a channel post", async () => {
    const channel = { id: (nextChat -= 1), type: "channel", title: "News" };
    const { watching } = await boundSource(undefined, channel);

    await botReads({ channel_post: { message_id: 9, date: 1_700_000_000, chat: channel, text: "Out now" } });

    const internal = String(channel.id).slice("-100".length);
    expect(await itemsOf(watching.id)).toMatchObject([{ title: "Out now", url: `https://t.me/c/${internal}/9` }]);
  });

  it("gives every Workspace watching the chat its own Item, and nothing to a chat no Source watches", async () => {
    const first = await boundSource();
    const second = await boundSource(undefined, first.chat);

    await botReads(message(first.chat, { text: "Shared news" }), message(group(), { text: "Nobody's" }));

    expect(await itemsOf(first.watching.id)).toHaveLength(1);
    expect(await itemsOf(second.watching.id)).toHaveLength(1);
  });

  it("doesn't capture a group's messages while its Source still waits for the bot", async () => {
    const waiting = await telegramSource(await newWorkspace());

    await botReads(message(group(), { text: "Too early" }));

    expect(await itemsOf(waiting.id)).toEqual([]);
  });

  it.each([
    ["removed from the group", "supergroup", "left", /The bot was removed from this chat/],
    ["banned from the group", "supergroup", "kicked", /The bot was removed from this chat and banned/],
    ["no longer an admin of the channel", "channel", "member", /The bot is no longer an admin of this channel/],
    ["restricted and out of the group", "supergroup", "restricted", /The bot was removed from this chat/],
  ])("makes the Source failing with a readable last error when the bot is %s", async (_name, type, status, error) => {
    const { watching, chat } = await boundSource(undefined, { ...group(), type });

    await botReads({
      my_chat_member: { chat, from: { id: 1 }, date: 1, new_chat_member: { status, is_member: false, user: { id: 2 } } },
    });

    const failing = await readSource(watching.id);
    expect(failing?.health).toBe("failing");
    expect(failing?.lastError).toMatch(error);
    expect(failing?.lastError).toMatch(/new link/);
    expect(failing?.lastErrorAt).toBeInstanceOf(Date);
  });

  it("keeps the Source ok when the bot is made an admin", async () => {
    const { watching, chat } = await boundSource();

    await botReads({ my_chat_member: { chat, from: { id: 1 }, date: 1, new_chat_member: { status: "administrator" } } });

    expect(await readSource(watching.id)).toMatchObject({ health: "ok", lastError: null });
  });

  it("makes the Source ok again when the bot is back in the chat", async () => {
    const { watching, chat } = await boundSource();
    const status = (to: string) => ({ my_chat_member: { chat, from: { id: 1 }, date: 1, new_chat_member: { status: to } } });

    await botReads(status("left"), status("member"));

    expect(await readSource(watching.id)).toMatchObject({ health: "ok", lastError: null, lastErrorAt: null });
  });

  it("moves the other Workspaces' Sources when one already watches the supergroup", async () => {
    const basic = { id: (nextChat -= 1), type: "group", title: "Team" };
    const supergroup = { id: (nextChat -= 1), type: "supergroup", title: "Team" };
    const workspaceId = await newWorkspace();
    const stays = await boundSource(workspaceId, basic);
    await boundSource(workspaceId, supergroup);
    const moves = await boundSource(undefined, basic);

    await botReads(message(basic, { migrate_to_chat_id: supergroup.id }));

    expect((await readSource(moves.watching.id))?.config).toMatchObject({ chatId: supergroup.id });
    expect((await readSource(stays.watching.id))?.config).toMatchObject({ chatId: basic.id });
  });

  it("moves the Source to the new chat when its group becomes a supergroup", async () => {
    const basic = { id: (nextChat -= 1), type: "group", title: "Team" };
    const { watching } = await boundSource(undefined, basic);
    const supergroup = { id: (nextChat -= 1), type: "supergroup", title: "Team" };

    await botReads(message(basic, { migrate_to_chat_id: supergroup.id }), message(supergroup, { text: "After the move" }));

    expect((await readSource(watching.id))?.config).toEqual({ via: "bot", chatId: supergroup.id, title: "Team" });
    expect((await itemsOf(watching.id)).map(({ title }) => title)).toEqual(["After the move"]);
  });
});
