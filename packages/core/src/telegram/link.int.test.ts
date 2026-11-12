import { randomBytes } from "node:crypto";
import { closeDb, createDb, type Db, destination, eq, migrate, source, telegramLinkCode, user, workspace } from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { decryptSecret } from "../secrets/secrets.ts";
import { runBot } from "./bot-runner.ts";
import { issueLinkCode, linkChat, linkCodeMinutes, liveLinkCode, purgeExpiredLinkCodes } from "./link.ts";

const encryptionKey = randomBytes(32);
const chat = { id: "-100200", title: "Ops room", type: "supergroup" };
const unknownCode = /unknown or has expired/;

describe("linking a Telegram chat", () => {
  let db: Db;
  let workspaceId = "";

  beforeAll(async () => {
    const postgres = await startPostgres();
    await migrate(postgres.url);
    db = createDb(postgres.url);
    await db.insert(user).values({ id: "owner", name: "Owner", email: "owner@example.com" });
    const [saved] = await db.insert(workspace).values({ name: "Workspace", ownerUserId: "owner" }).returning();
    workspaceId = saved?.id ?? "";
    return async () => {
      await closeDb(db);
      await postgres.stop();
    };
  }, 120_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function waiting() {
    const [row] = await db
      .insert(destination)
      .values({ workspaceId, type: "telegram", name: crypto.randomUUID() })
      .returning();
    if (row === undefined) throw new Error("Nothing was saved");
    return row;
  }

  const read = async (id: string) => db.query.destination.findFirst({ where: eq(destination.id, id) });
  const codesOf = (id: string) => db.select().from(telegramLinkCode).where(eq(telegramLinkCode.destinationId, id));

  const age = (id: string) =>
    db
      .update(telegramLinkCode)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(telegramLinkCode.destinationId, id));

  /**
   * Sends the bot one message from a chat, through the real runner and a fake Bot API, and gives its replies.
   * Telegram gives the message again on each poll until the runner moves past it.
   */
  async function sendToBot(text: string, from: { id: number; type: string; title?: string }, key = encryptionKey) {
    const replies: string[] = [];
    const stopping = new AbortController();
    await runBot(
      {
        botToken: "123456:secret-token",
        linkChat: (code, bound) => linkChat(db, key, code, bound),
        intake: () => Promise.resolve(),
        pingDatabase: () => db.$client.query("select 1"),
        retryMs: 1,
        fetch: (input, init) => {
          const method = String(input).split("/").at(-1);
          if (method === "getMe") return Promise.resolve(Response.json({ result: { username: "WatchdogBot" } }));
          if (method === "sendMessage") {
            const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
            replies.push(typeof body === "object" && body !== null && "text" in body ? String(body.text) : "");
            return Promise.resolve(Response.json({ result: {} }));
          }
          const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
          if (typeof body === "object" && body !== null && !("offset" in body)) {
            return Promise.resolve(Response.json({ result: [{ update_id: 1, message: { message_id: 1, date: 1, text, chat: from } }] }));
          }
          stopping.abort();
          return Promise.reject(new DOMException("stopped", "AbortError"));
        },
      },
      stopping.signal,
    );
    return replies;
  }

  it("binds the chat when /start <code> reaches the bot in time, and replies with the name", async () => {
    const { id, name } = await waiting();
    const code = await issueLinkCode(db, { destinationId: id });

    expect(await sendToBot(`/start ${code}`, { id: -100200, type: "supergroup", title: "Ops room" })).toEqual([
      `Linked to ${name} in Watchdog`,
    ]);

    const linked = await read(id);
    expect(linked?.confirmedAt).toBeInstanceOf(Date);
    expect(linked?.config).toEqual({ chat: "Ops room" });
  });

  it("refuses an expired code with a reply, and the Destination stays waiting", async () => {
    const { id } = await waiting();
    const code = await issueLinkCode(db, { destinationId: id });
    await age(id);

    const replies = await sendToBot(`/start ${code}`, { id: 42, type: "private" });

    expect(replies).toEqual([expect.stringMatching(unknownCode)]);
    const left = await read(id);
    expect(left?.confirmedAt).toBeNull();
    expect(left?.secretCiphertext).toBeNull();
  });

  it("asks again when linking keeps failing with the database up, and the code still links after", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const { id, name } = await waiting();
    const code = await issueLinkCode(db, { destinationId: id });

    // A key of the wrong length throws inside the transaction, after the code's row was deleted.
    expect(await sendToBot(`/start ${code}`, { id: 42, type: "private" }, randomBytes(16))).toEqual([
      "Watchdog couldn't link this chat. Try the same link again.",
    ]);
    expect(await codesOf(id)).toHaveLength(1);

    expect(await sendToBot(`/start ${code}`, { id: 42, type: "private" })).toEqual([`Linked to ${name} in Watchdog`]);
  });

  it("issues a code a deep link can carry, stored only as a hash, for 15 minutes", async () => {
    const { id } = await waiting();

    const code = await issueLinkCode(db, { destinationId: id });

    expect(code).toMatch(/^[\w-]{22}$/);
    const [stored] = await codesOf(id);
    expect(stored?.codeHash).not.toContain(code);
    const minutes = ((stored?.expiresAt.getTime() ?? 0) - Date.now()) / 60_000;
    expect(linkCodeMinutes).toBe(15);
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
  });

  it("binds the chat, encrypted, confirms the Destination and spends the code", async () => {
    const { id, name } = await waiting();
    const code = await issueLinkCode(db, { destinationId: id });

    expect(await linkChat(db, encryptionKey, code, chat)).toBe(`Linked to ${name} in Watchdog`);

    const linked = await read(id);
    expect(linked?.confirmedAt).toBeInstanceOf(Date);
    expect(linked?.config).toEqual({ chat: "Ops room" });
    expect(linked?.secretCiphertext).not.toContain("-100200");
    expect(decryptSecret(linked?.secretCiphertext ?? "", encryptionKey)).toBe("-100200");
    expect(await codesOf(id)).toEqual([]);
  });

  it("refuses a code the second time", async () => {
    const { id } = await waiting();
    const code = await issueLinkCode(db, { destinationId: id });
    await linkChat(db, encryptionKey, code, chat);

    expect(await linkChat(db, encryptionKey, code, { id: "1", title: "Private chat", type: "private" })).toMatch(unknownCode);

    expect(decryptSecret((await read(id))?.secretCiphertext ?? "", encryptionKey)).toBe("-100200");
  });

  it("refuses an unknown code", async () => {
    expect(await linkChat(db, encryptionKey, "no-such-code", chat)).toMatch(unknownCode);
  });

  it("takes the Destination before the code, so it can't deadlock with removing the Destination", async () => {
    const { id } = await waiting();
    const code = await issueLinkCode(db, { destinationId: id });
    const remove = await db.$client.connect();
    try {
      // What removeDestination does: the Destination's row, then the code's through the cascade.
      await remove.query("begin");
      await remove.query("select 1 from destination where id = $1 for update", [id]);
      const linking = linkChat(db, encryptionKey, code, chat);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await remove.query("set local lock_timeout = '2s'");
      await remove.query("delete from destination where id = $1", [id]);
      await remove.query("commit");

      expect(await linking).toMatch(unknownCode);
    } finally {
      remove.release();
    }
  });

  it("leaves one live code when two are asked for at once", async () => {
    const { id } = await waiting();

    await Promise.all(Array.from({ length: 10 }, () => issueLinkCode(db, { destinationId: id })));

    expect(await codesOf(id)).toHaveLength(1);
  });

  it("can't rebind a linked chat with a code that was still live", async () => {
    const { id } = await waiting();
    const first = await issueLinkCode(db, { destinationId: id });
    await linkChat(db, encryptionKey, first, chat);
    // A code that slipped in just after the link, as a page open from before it could ask for.
    const late = await issueLinkCode(db, { destinationId: id });

    expect(await linkChat(db, encryptionKey, late, { id: "1", title: "Private chat", type: "private" })).toMatch(unknownCode);

    expect(decryptSecret((await read(id))?.secretCiphertext ?? "", encryptionKey)).toBe("-100200");
  });

  it("drops a NUL from a chat's title, which jsonb refuses and would stop the loop on this update", async () => {
    const { id, name } = await waiting();
    const code = await issueLinkCode(db, { destinationId: id });

    expect(await linkChat(db, encryptionKey, code, { ...chat, title: "Ops\0 room" })).toBe(`Linked to ${name} in Watchdog`);

    expect((await read(id))?.config).toEqual({ chat: "Ops room" });
  });

  it("lets a new code replace the last one", async () => {
    const { id, name } = await waiting();
    const replaced = await issueLinkCode(db, { destinationId: id });

    const code = await issueLinkCode(db, { destinationId: id });

    expect(await linkChat(db, encryptionKey, replaced, chat)).toMatch(unknownCode);
    expect(await linkChat(db, encryptionKey, code, chat)).toBe(`Linked to ${name} in Watchdog`);
  });

  it("finds a live code without spending it, and not an expired one", async () => {
    const { id } = await waiting();
    const code = await issueLinkCode(db, { destinationId: id });

    const live = await liveLinkCode(db, code);
    expect(live?.destinationId).toBe(id);
    expect(live?.expiresAt).toBeInstanceOf(Date);
    expect(await codesOf(id)).toHaveLength(1);

    await age(id);
    expect(await liveLinkCode(db, code)).toBeUndefined();
  });

  it("purges an expired code and leaves a live one, which still links", async () => {
    const stale = await waiting();
    const fresh = await waiting();
    await issueLinkCode(db, { destinationId: stale.id });
    const code = await issueLinkCode(db, { destinationId: fresh.id });
    await age(stale.id);

    await purgeExpiredLinkCodes(db);

    expect(await codesOf(stale.id)).toEqual([]);
    expect(await codesOf(fresh.id)).toHaveLength(1);
    expect(await linkChat(db, encryptionKey, code, chat)).toBe(`Linked to ${fresh.name} in Watchdog`);
  });
  describe("to a Telegram bot Source", () => {
    async function waitingSource(name: string = crypto.randomUUID()) {
      const [row] = await db
        .insert(source)
        .values({ workspaceId, type: "telegram", name, config: { via: "bot" }, schedule: null, nextPollAt: null })
        .returning();
      if (row === undefined) throw new Error("Nothing was saved");
      return row;
    }
    const readSource = async (id: string) => db.query.source.findFirst({ where: eq(source.id, id) });
    const group = (id: string) => ({ id, title: "Ops room", type: "supergroup" });

    it("binds the chat through the runner, stores its id and title, and spends the code", async () => {
      const { id, name } = await waitingSource();
      const code = await issueLinkCode(db, { sourceId: id });

      expect(await sendToBot(`/start@WatchdogBot ${code}`, { id: -100700, type: "supergroup", title: "Ops room" })).toEqual([
        `Watching this chat for ${name} in Watchdog`,
      ]);

      const bound = await readSource(id);
      expect(bound?.config).toEqual({ via: "bot", chatId: -100700, title: "Ops room" });
      expect(bound?.dedupKey).toBe("-100700");
      expect(await liveLinkCode(db, code)).toBeUndefined();
    });

    it("refuses a private chat and keeps the code for the right chat", async () => {
      const { id } = await waitingSource();
      const code = await issueLinkCode(db, { sourceId: id });

      expect(await linkChat(db, encryptionKey, code, { id: "42", title: "Private chat", type: "private" })).toMatch(
        /A private chat can't be a Source/,
      );

      expect((await readSource(id))?.config).toEqual({ via: "bot" });
      expect((await liveLinkCode(db, code))?.sourceId).toBe(id);
    });

    it("names the Source that already watches the chat, spends the code posted there, and the new one keeps waiting", async () => {
      const watching = await waitingSource("Ops chat");
      await linkChat(db, encryptionKey, await issueLinkCode(db, { sourceId: watching.id }), group("-100701"));
      const { id } = await waitingSource();
      const code = await issueLinkCode(db, { sourceId: id });

      expect(await linkChat(db, encryptionKey, code, group("-100701"))).toBe(
        "This chat is already watched by Ops chat in Watchdog",
      );

      expect((await readSource(id))?.config).toEqual({ via: "bot" });
      // Everyone in that chat saw the code, so it mustn't bind their own chat later.
      expect(await liveLinkCode(db, code)).toBeUndefined();
    });

    it("makes a Source that lost access ok again when it is bound again", async () => {
      const { id, name } = await waitingSource();
      await linkChat(db, encryptionKey, await issueLinkCode(db, { sourceId: id }), group("-100702"));
      await db
        .update(source)
        .set({ health: "failing", lastError: "The bot was removed", lastErrorAt: new Date() })
        .where(eq(source.id, id));

      expect(await linkChat(db, encryptionKey, await issueLinkCode(db, { sourceId: id }), group("-100702"))).toBe(
        `Watching this chat for ${name} in Watchdog`,
      );

      expect(await readSource(id)).toMatchObject({ health: "ok", lastError: null, lastErrorAt: null });
    });

    it("gives a code to the Source alone, never to a Destination", async () => {
      const { id } = await waitingSource();
      const code = await issueLinkCode(db, { sourceId: id });

      expect(await liveLinkCode(db, code)).toMatchObject({ sourceId: id, destinationId: null });
    });
  });
});
