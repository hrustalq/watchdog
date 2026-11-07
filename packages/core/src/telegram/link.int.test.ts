import { randomBytes } from "node:crypto";
import { closeDb, createDb, type Db, destination, eq, migrate, telegramLinkCode, user, workspace } from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { decryptSecret } from "../secrets/secrets.ts";
import { runBot } from "./bot-runner.ts";
import { issueLinkCode, linkChat, linkCodeMinutes, liveLinkCode } from "./link.ts";

const encryptionKey = randomBytes(32);
const chat = { id: "-100200", title: "Ops room" };

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

  /** Sends the bot one message from a chat, through the real runner and a fake Bot API, and gives its replies. */
  async function sendToBot(text: string, from: { id: number; title?: string }) {
    const replies: string[] = [];
    const stopping = new AbortController();
    let polls = 0;
    await runBot(
      {
        botToken: "123456:secret-token",
        linkChat: (code, bound) => linkChat(db, encryptionKey, code, bound),
        fetch: (input, init) => {
          const method = String(input).split("/").at(-1);
          if (method === "getMe") return Promise.resolve(Response.json({ result: { username: "WatchdogBot" } }));
          if (method === "sendMessage") {
            const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
            replies.push(typeof body === "object" && body !== null && "text" in body ? String(body.text) : "");
            return Promise.resolve(Response.json({ result: {} }));
          }
          polls += 1;
          if (polls === 1) {
            return Promise.resolve(Response.json({ result: [{ update_id: 1, message: { text, chat: from } }] }));
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
    const code = await issueLinkCode(db, id);

    expect(await sendToBot(`/start ${code}`, { id: -100200, title: "Ops room" })).toEqual([
      `Linked to ${name} in Watchdog`,
    ]);

    const linked = await read(id);
    expect(linked?.confirmedAt).toBeInstanceOf(Date);
    expect(linked?.config).toEqual({ chat: "Ops room" });
  });

  it("refuses an expired code with a reply, and the Destination stays waiting", async () => {
    const { id } = await waiting();
    const code = await issueLinkCode(db, id);
    await age(id);

    const replies = await sendToBot(`/start ${code}`, { id: 42 });

    expect(replies).toEqual([expect.stringMatching(/unknown or has expired/)]);
    const left = await read(id);
    expect(left?.confirmedAt).toBeNull();
    expect(left?.secretCiphertext).toBeNull();
  });

  it("issues a code a deep link can carry, stored only as a hash, for 15 minutes", async () => {
    const { id } = await waiting();

    const code = await issueLinkCode(db, id);

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
    const code = await issueLinkCode(db, id);

    expect(await linkChat(db, encryptionKey, code, chat)).toBe(name);

    const linked = await read(id);
    expect(linked?.confirmedAt).toBeInstanceOf(Date);
    expect(linked?.config).toEqual({ chat: "Ops room" });
    expect(linked?.secretCiphertext).not.toContain("-100200");
    expect(decryptSecret(linked?.secretCiphertext ?? "", encryptionKey)).toBe("-100200");
    expect(await codesOf(id)).toEqual([]);
  });

  it("refuses a code the second time", async () => {
    const { id } = await waiting();
    const code = await issueLinkCode(db, id);
    await linkChat(db, encryptionKey, code, chat);

    expect(await linkChat(db, encryptionKey, code, { id: "1", title: "private chat" })).toBeUndefined();

    expect(decryptSecret((await read(id))?.secretCiphertext ?? "", encryptionKey)).toBe("-100200");
  });

  it("refuses an unknown code", async () => {
    expect(await linkChat(db, encryptionKey, "no-such-code", chat)).toBeUndefined();
  });

  it("takes the Destination before the code, so it can't deadlock with removing the Destination", async () => {
    const { id } = await waiting();
    const code = await issueLinkCode(db, id);
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

      expect(await linking).toBeUndefined();
    } finally {
      remove.release();
    }
  });

  it("leaves one live code when two are asked for at once", async () => {
    const { id } = await waiting();

    await Promise.all(Array.from({ length: 10 }, () => issueLinkCode(db, id)));

    expect(await codesOf(id)).toHaveLength(1);
  });

  it("can't rebind a linked chat with a code that was still live", async () => {
    const { id } = await waiting();
    const first = await issueLinkCode(db, id);
    await linkChat(db, encryptionKey, first, chat);
    // A code that slipped in just after the link, as a page open from before it could ask for.
    const late = await issueLinkCode(db, id);

    expect(await linkChat(db, encryptionKey, late, { id: "1", title: "Private chat" })).toBeUndefined();

    expect(decryptSecret((await read(id))?.secretCiphertext ?? "", encryptionKey)).toBe("-100200");
  });

  it("drops a NUL from a chat's title, which jsonb refuses and would stop the loop on this update", async () => {
    const { id, name } = await waiting();
    const code = await issueLinkCode(db, id);

    expect(await linkChat(db, encryptionKey, code, { id: "1", title: "Ops\0 room" })).toBe(name);

    expect((await read(id))?.config).toEqual({ chat: "Ops room" });
  });

  it("lets a new code replace the last one", async () => {
    const { id, name } = await waiting();
    const replaced = await issueLinkCode(db, id);

    const code = await issueLinkCode(db, id);

    expect(await linkChat(db, encryptionKey, replaced, chat)).toBeUndefined();
    expect(await linkChat(db, encryptionKey, code, chat)).toBe(name);
  });

  it("finds a live code without spending it, and not an expired one", async () => {
    const { id } = await waiting();
    const code = await issueLinkCode(db, id);

    const live = await liveLinkCode(db, code);
    expect(live?.destinationId).toBe(id);
    expect(live?.expiresAt).toBeInstanceOf(Date);
    expect(await codesOf(id)).toHaveLength(1);

    await age(id);
    expect(await liveLinkCode(db, code)).toBeUndefined();
  });
});
