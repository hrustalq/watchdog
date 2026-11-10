import { randomBytes } from "node:crypto";
import { Long, PeersIndex, RawUpdateInfo, tl } from "@mtcute/node";
import { NodeCryptoProvider } from "@mtcute/node/utils.js";
import { createStub, StubTelegramClient } from "@mtcute/test";
import { and, closeDb, createDb, type Db, eq, item, migrate, source, telegramSession, user, workspace } from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../../secrets/secrets.ts";
import { revokedError, revokeSession } from "./login.ts";
import { loggedOutError, runSession } from "./runner.ts";
import { requestRevoke, sessionChats, watchChat } from "./session.ts";

const encryptionKey = randomBytes(32);
const day = 24 * 60 * 60;
const waitLong = { timeout: 10_000, interval: 20 };

const channelId = 1_234_567_890;
const chatId = -1_000_000_000_000 - channelId;
// The stub gives every vector a default of [], and mtcute reads a channel's first extra username
// when `usernames` is there, which Telegram only sends with one in it.
const channel = (fields: Partial<tl.RawChannel>) => {
  const stub = createStub("channel", fields);
  delete stub.usernames;
  return stub;
};
const opsRoom = channel({ id: channelId, title: "Ops room", megagroup: true, accessHash: Long.fromNumber(77) });
const news = channel({ id: 555, title: "News", broadcast: true, accessHash: Long.fromNumber(78) });
const ada = createStub("user", { id: 5, firstName: "Ada", lastName: "Lovelace", accessHash: Long.fromNumber(79) });
const peers = () => PeersIndex.from({ chats: [opsRoom, news], users: [ada] });

const now = () => Math.floor(Date.now() / 1000);
const message = (id: number, text: string, date = now(), inChannel = channelId) =>
  createStub("message", {
    id,
    peerId: { _: "peerChannel", channelId: inChannel },
    fromId: { _: "peerUser", userId: ada.id },
    date,
    message: text,
  });

describe("a Telegram user session's runner", () => {
  let db: Db;
  let workspaceId = "";
  let sessionId = "";
  let telegram: StubTelegramClient;
  let history: tl.TypeMessage[];
  let historyAsked: { minId: number; limit: number }[];
  let enqueued: string[];
  let failCaptures: boolean;
  let stopping: AbortController;

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

  beforeEach(async () => {
    await db.delete(source);
    await db.delete(telegramSession);
    history = [];
    historyAsked = [];
    enqueued = [];
    failCaptures = false;
    stopping = new AbortController();
    // Node's crypto, because the stub's default is the browser's, which loads its WebAssembly through fetch.
    telegram = new StubTelegramClient({ crypto: new NodeCryptoProvider() });
    await telegram.registerPeers(opsRoom, news, ada);
    // One page: the next, which starts after its last dialog, is empty.
    telegram.respondWith("messages.getDialogs", ({ offsetPeer }) =>
      createStub("messages.dialogs", {
        dialogs: offsetPeer._ !== "inputPeerEmpty" ? [] : [
          createStub("dialog", { peer: { _: "peerChannel", channelId } }),
          createStub("dialog", { peer: { _: "peerChannel", channelId: news.id } }),
          createStub("dialog", { peer: { _: "peerUser", userId: ada.id } }),
        ],
        messages: [],
        chats: [opsRoom, news],
        users: [ada],
      }),
    );
    telegram.respondWith("updates.getState", () => createStub("updates.state"));
    telegram.respondWith("messages.getHistory", ({ minId, limit, offsetId }) => {
      historyAsked.push({ minId, limit });
      const messages = history
        .filter((sent) => sent.id > minId && (offsetId === 0 || sent.id < offsetId))
        .toSorted((a, b) => b.id - a.id)
        .slice(0, limit);
      return createStub("messages.channelMessages", { messages, chats: [opsRoom], users: [ada], count: messages.length });
    });
    const [session] = await db
      .insert(telegramSession)
      .values({ workspaceId, account: "Ada Lovelace", secretCiphertext: encryptSecret(await telegram.exportSession(), encryptionKey) })
      .returning();
    sessionId = session?.id ?? "";
  });

  afterEach(() => {
    stopping.abort();
  });

  const deps = () => ({
    encryptionKey,
    createClient: () => telegram,
    enqueueItems: (_tx: unknown, ids: string[]) => {
      if (failCaptures) {
        failCaptures = false;
        return Promise.reject(new Error("the database went away"));
      }
      enqueued.push(...ids);
      return Promise.resolve();
    },
    tickMs: 10,
    checkMs: 50,
  });
  const run = (until = new Date(Date.now() + 60 * 60 * 1000)) => runSession(db, deps(), sessionId, { signal: stopping.signal, until });
  const sessionRow = async () => (await db.select().from(telegramSession).where(eq(telegramSession.id, sessionId)))[0];
  const itemsOf = (sourceId: string) => db.select().from(item).where(eq(item.sourceId, sourceId));
  const sessionSource = async (fields: Partial<typeof source.$inferInsert> = {}) => {
    const [row] = await db
      .insert(source)
      .values({
        workspaceId,
        type: "telegram",
        name: "Ops room",
        config: { via: "session", chatId, title: "Ops room" },
        schedule: null,
        nextPollAt: null,
        ...fields,
      })
      .returning();
    if (row === undefined) throw new Error("Nothing was saved");
    return row;
  };
  const arrives = (sent: tl.TypeMessage, update: "updateNewChannelMessage" | "updateEditChannelMessage" = "updateNewChannelMessage") => {
    telegram.onRawUpdate.emit(new RawUpdateInfo(createStub(update, { message: sent, pts: 1, ptsCount: 1 }), peers()));
  };

  it("reads the account's groups and channels as the list to pick from, leaving private chats out", async () => {
    const turn = run();

    await vi.waitFor(async () => {
      expect((await sessionRow())?.dialogs).toEqual([
        { id: chatId, title: "Ops room", type: "supergroup" },
        { id: -1_000_000_000_555, title: "News", type: "channel" },
      ]);
    }, waitLong);
    stopping.abort();
    await turn;
  });

  it("backfills a picked chat's last 7 days, at most 50, then captures its new messages as Items", async () => {
    history = [message(1, "Too old", now() - 8 * day), ...Array.from({ length: 60 }, (_, index) => message(index + 2, `Message ${String(index + 2)}`))];
    const turn = run();
    await vi.waitFor(async () => {
      expect((await sessionRow())?.dialogs).not.toBeNull();
    }, waitLong);

    expect(await watchChat(db, workspaceId, chatId)).toEqual({ watched: "Ops room" });
    const [picked] = await db.select().from(source).where(eq(source.workspaceId, workspaceId));
    if (picked === undefined) throw new Error("The chat wasn't saved as a Source");
    await vi.waitFor(async () => {
      expect(await itemsOf(picked.id)).toHaveLength(50);
    }, waitLong);
    const backfilled = await itemsOf(picked.id);
    expect(backfilled.every((captured) => captured.isBackfill)).toBe(true);
    expect(backfilled.map((captured) => captured.title)).toContain("Message 61");
    expect(backfilled.map((captured) => captured.title)).not.toContain("Too old");

    arrives(message(62, "Deploy failed on main"));

    await vi.waitFor(async () => {
      expect(await itemsOf(picked.id)).toHaveLength(51);
    }, waitLong);
    const [fresh] = await db
      .select()
      .from(item)
      .where(and(eq(item.sourceId, picked.id), eq(item.externalId, `${String(chatId)}:62`)));
    expect(fresh).toMatchObject({
      title: "Deploy failed on main",
      author: "Ada Lovelace",
      url: `https://t.me/c/${String(channelId)}/62`,
      isBackfill: false,
    });
    expect(enqueued).toContain(fresh?.id);
    stopping.abort();
    await turn;
  });

  it("catches up on everything that came in between turns, from the last message it read, a page at a time", async () => {
    const watching = await sessionSource({ backfilledAt: new Date(), fetchState: { lastMessageId: "10" } });
    history = Array.from({ length: 160 }, (_, index) => message(index + 1, `Message ${String(index + 1)}`));

    const turn = run();

    await vi.waitFor(async () => {
      expect(await itemsOf(watching.id)).toHaveLength(150);
    }, waitLong);
    const titles = (await itemsOf(watching.id)).map(({ title }) => title);
    expect(titles).toContain("Message 11");
    expect(titles).not.toContain("Message 10");
    expect(historyAsked).toEqual([
      { minId: 10, limit: 100 },
      { minId: 10, limit: 100 },
    ]);
    await vi.waitFor(async () => {
      expect((await db.select().from(source).where(eq(source.id, watching.id)))[0]?.fetchState).toEqual({ lastMessageId: "160" });
    }, waitLong);
    stopping.abort();
    await turn;
  });

  it("ignores edits, service messages, media without a caption, and chats it doesn't watch", async () => {
    const watching = await sessionSource({ backfilledAt: new Date() });
    const turn = run();
    await vi.waitFor(() => {
      expect(historyAsked).toHaveLength(1);
    }, waitLong);

    arrives(message(3, "Edited"), "updateEditChannelMessage");
    arrives(createStub("messageService", { id: 4, peerId: { _: "peerChannel", channelId }, date: now() }));
    arrives(message(5, ""));
    arrives(message(6, "Elsewhere", now(), news.id));
    arrives(message(7, "This one"));

    await vi.waitFor(async () => {
      expect((await itemsOf(watching.id)).map(({ title }) => title)).toEqual(["This one"]);
    }, waitLong);
    stopping.abort();
    await turn;
  });

  it("keeps where it read from after a capture fails, so the next turn reads that message again", async () => {
    const watching = await sessionSource({ backfilledAt: new Date(), fetchState: { lastMessageId: "61" } });
    const turn = run();
    await vi.waitFor(() => {
      expect(historyAsked).toHaveLength(1);
    }, waitLong);

    // The capture of the next message fails once, as if the database went away for it.
    failCaptures = true;
    arrives(message(62, "Lost to an outage"));
    arrives(message(63, "After the outage"));
    await vi.waitFor(async () => {
      expect((await itemsOf(watching.id)).map(({ title }) => title)).toEqual(["After the outage"]);
    }, waitLong);

    expect((await db.select().from(source).where(eq(source.id, watching.id)))[0]?.fetchState).toEqual({ lastMessageId: "61" });
    stopping.abort();
    await turn;
  });

  it("follows a group that became a supergroup, reading the supergroup from its first message", async () => {
    const team = createStub("chat", { id: 4001, title: "Team" });
    await telegram.registerPeers(team);
    const watching = await sessionSource({ config: { via: "session", chatId: -4001, title: "Team" }, backfilledAt: new Date(), fetchState: { lastMessageId: "500" } });
    const turn = run();
    await vi.waitFor(() => {
      expect(historyAsked).toHaveLength(1);
    }, waitLong);

    telegram.onRawUpdate.emit(
      new RawUpdateInfo(
        createStub("updateNewMessage", {
          message: createStub("messageService", {
            id: 501,
            peerId: { _: "peerChat", chatId: team.id },
            date: now(),
            action: { _: "messageActionChatMigrateTo", channelId },
          }),
        }),
        PeersIndex.from({ chats: [team], users: [] }),
      ),
    );

    await vi.waitFor(async () => {
      expect((await db.select().from(source).where(eq(source.id, watching.id)))[0]).toMatchObject({
        config: { chatId },
        fetchState: { lastMessageId: "0" },
      });
    }, waitLong);
    stopping.abort();
    await turn;
  });

  it("makes a Source failing when Telegram can't find its chat, and goes on reading the others", async () => {
    const gone = await sessionSource({ config: { via: "session", chatId: -1_000_000_000_999, title: "Gone" }, backfilledAt: new Date() });
    const watching = await sessionSource({ name: "Ops room", backfilledAt: new Date() });
    telegram.respondWith("channels.getChannels", () => {
      throw new tl.RpcError(400, "CHANNEL_INVALID");
    });
    const turn = run();

    await vi.waitFor(async () => {
      expect((await db.select().from(source).where(eq(source.id, gone.id)))[0]?.health).toBe("failing");
    }, waitLong);
    arrives(message(9, "Still here"));
    await vi.waitFor(async () => {
      expect((await itemsOf(watching.id)).map(({ title }) => title)).toEqual(["Still here"]);
    }, waitLong);
    stopping.abort();
    await turn;
  });

  it("notices in the middle of a turn that Telegram logged the session out", async () => {
    const watching = await sessionSource();
    const turn = run();
    await vi.waitFor(() => {
      expect(historyAsked).toHaveLength(1);
    }, waitLong);

    telegram.respondWith("updates.getState", () => {
      throw new tl.RpcError(401, "AUTH_KEY_UNREGISTERED");
    });
    await turn;

    expect(await sessionRow()).toBeUndefined();
    expect((await db.select().from(source).where(eq(source.id, watching.id)))[0]?.lastError).toBe(loggedOutError);
  });

  it("makes a Source failing when the account can't read its chat, and ok again once it can", async () => {
    const watching = await sessionSource({ backfilledAt: new Date() });
    telegram.respondWith("messages.getHistory", () => {
      throw new tl.RpcError(400, "CHANNEL_PRIVATE");
    });
    const failingTurn = run();

    await vi.waitFor(async () => {
      const [failing] = await db.select().from(source).where(eq(source.id, watching.id));
      expect(failing?.health).toBe("failing");
      expect(failing?.lastError).toMatch(/can't read this chat/);
    }, waitLong);
    stopping.abort();
    await failingTurn;

    stopping = new AbortController();
    telegram = new StubTelegramClient({ crypto: new NodeCryptoProvider() });
    await telegram.registerPeers(opsRoom, ada);
    telegram.respondWith("messages.getDialogs", () => createStub("messages.dialogs", { dialogs: [], messages: [], chats: [], users: [] }));
    telegram.respondWith("messages.getHistory", () => createStub("messages.channelMessages", { messages: [], chats: [], users: [] }));
    const turn = run();

    await vi.waitFor(async () => {
      expect((await db.select().from(source).where(eq(source.id, watching.id)))[0]).toMatchObject({ health: "ok", lastError: null });
    }, waitLong);
    stopping.abort();
    await turn;
  });

  it("stops when the session is revoked, and the revoke makes its Sources failing", async () => {
    const watching = await sessionSource();
    const turn = run();
    await vi.waitFor(() => {
      expect(historyAsked).toHaveLength(1);
    }, waitLong);

    const jobs: string[] = [];
    expect(
      await requestRevoke(db, workspaceId, (_tx, id) => {
        jobs.push(id);
        return Promise.resolve();
      }),
    ).toBe(true);
    await turn;
    const revoking = new StubTelegramClient({ crypto: new NodeCryptoProvider() });
    await revoking.connect();
    revoking.respondWith("auth.logOut", () => createStub("auth.loggedOut"));
    await revokeSession(db, { encryptionKey, createClient: () => revoking }, jobs[0] ?? "");

    expect(await sessionRow()).toBeUndefined();
    expect((await db.select().from(source).where(eq(source.id, watching.id)))[0]).toMatchObject({
      health: "failing",
      lastError: revokedError,
    });
  });

  it("deletes a session Telegram logged out, and makes its Sources failing", async () => {
    const watching = await sessionSource();
    telegram.respondWith("messages.getDialogs", () => {
      throw new tl.RpcError(401, "AUTH_KEY_UNREGISTERED");
    });

    await run();

    expect(await sessionRow()).toBeUndefined();
    expect((await db.select().from(source).where(eq(source.id, watching.id)))[0]).toMatchObject({
      health: "failing",
      lastError: loggedOutError,
    });
  });

  it("ends the turn when Telegram asks to wait past it, and doesn't start one before the wait is over", async () => {
    telegram.respondWith("messages.getDialogs", () => {
      throw tl.RpcError.fromTl({ errorCode: 420, errorMessage: "FLOOD_WAIT_600" });
    });

    await run(new Date(Date.now() + 60_000));

    const waitUntil = (await sessionRow())?.waitUntil?.getTime() ?? 0;
    expect(waitUntil).toBeGreaterThan(Date.now() + 590_000);
    let asked = false;
    telegram.respondWith("messages.getDialogs", () => {
      asked = true;
      throw new Error("called during the wait");
    });
    await run();
    expect(asked).toBe(false);
  });

  it("refuses to watch a chat that isn't in the session's list, and doesn't save one twice", async () => {
    await db
      .update(telegramSession)
      .set({ dialogs: [{ id: chatId, title: "Ops room", type: "supergroup" }] })
      .where(eq(telegramSession.id, sessionId));

    expect(await sessionChats(db, workspaceId)).toEqual([{ id: chatId, title: "Ops room", type: "supergroup", watchedAs: null }]);
    expect(await watchChat(db, workspaceId, -100_999)).toEqual({ refused: "not-listed" });
    expect(await watchChat(db, workspaceId, chatId)).toEqual({ watched: "Ops room" });
    expect(await sessionChats(db, workspaceId)).toMatchObject([{ id: chatId, watchedAs: "Ops room" }]);
    expect(await watchChat(db, workspaceId, chatId)).toEqual({ refused: "watched" });
    expect(await db.select().from(source).where(eq(source.workspaceId, workspaceId))).toMatchObject([
      { name: "Ops room", config: { via: "session", chatId, title: "Ops room" }, schedule: null, nextPollAt: null },
    ]);
  });
});
