import {
  action,
  actionDestination,
  and,
  closeDb,
  createDb,
  type Db,
  destination,
  digestItem,
  eq,
  isNotNull,
  item,
  itemLog,
  migrate,
  sentMessage,
  source,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres, type TestPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import type { Destination, Sender } from "./deliver.ts";
import { dueDigests, sendDigest, type DigestDeps } from "./digest.ts";
import type { GroupedAlert } from "./group.ts";
import { checkUnsubscribeToken } from "./unsubscribe.ts";

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}

const appUrl = "https://watchdog.test";
const secret = "a-better-auth-secret-of-at-least-32-chars";
const saved = new Date("2026-11-02T12:00:00Z");
// 08:00 in Moscow, which is UTC+3 all year.
const eightInMoscow = new Date("2026-11-03T05:00:00Z");

describe("Digests", () => {
  let postgres: TestPostgres;
  let db: Db;

  beforeAll(async () => {
    postgres = await startPostgres();
    await migrate(postgres.url);
    db = createDb(postgres.url);
    return async () => {
      await closeDb(db);
      await postgres.stop();
    };
  }, 120_000);

  /** Records every message instead of sending it, and fails for the Destinations named in `failing`. */
  function recordingSenders(failing: string[] = []) {
    const sent: { to: string; message: GroupedAlert }[] = [];
    const sender: Sender = {
      send: (target: Destination, message) => {
        if (failing.includes(target.name)) return Promise.reject(new Error("the mail server can't be reached"));
        if (!("lines" in message)) throw new Error("A Digest is sent as a list");
        sent.push({ to: target.name, message });
        return Promise.resolve();
      },
    };
    return { sent, senders: { telegram: sender, email: sender } };
  }

  /** A Workspace in Moscow with a Digest on `0 8 * * *`, saved before the test's times. */
  async function seed(timezone = "Europe/Moscow") {
    const ownerId = crypto.randomUUID();
    await db.insert(user).values({ id: ownerId, name: "Owner", email: `${ownerId}@example.com` });
    const [ws] = await db.insert(workspace).values({ name: "Workspace", ownerUserId: ownerId, timezone }).returning();
    const workspaceId = present(ws).id;
    const [src] = await db
      .insert(source)
      .values({ workspaceId, type: "rss", name: "HN", config: { url: "https://feeds.test/hn.rss" }, schedule: "*/15 * * * *" })
      .returning();
    const sourceId = present(src).id;

    const addDestination = async (name: string, values: Partial<typeof destination.$inferInsert> = {}) => {
      const [row] = await db
        .insert(destination)
        .values({ workspaceId, type: "email", name, config: { address: `${name}@example.com` }, confirmedAt: saved, ...values })
        .returning();
      return present(row).id;
    };
    const inbox = await addDestination("inbox");
    const definition = { action: "Morning", when: { field: "severity", op: "gte", value: 1 }, kind: "digest", schedule: "0 8 * * *" };
    const [digest] = await db
      .insert(action)
      .values({
        workspaceId,
        name: "Morning",
        kind: "digest",
        definition: { ...definition, destinations: [inbox] },
        createdAt: saved,
        updatedAt: saved,
      })
      .returning();
    const actionId = present(digest).id;
    const listed = [inbox];
    /** Points the Digest at another Destination too. */
    const point = async (destinationId: string) => {
      listed.push(destinationId);
      await db.insert(actionDestination).values({ actionId, destinationId });
      await db.update(action).set({ definition: { ...definition, destinations: listed }, updatedAt: saved }).where(eq(action.id, actionId));
    };
    await db.insert(actionDestination).values({ actionId, destinationId: inbox });

    let count = 0;
    /** Collects a new Item into the Digest, for each Destination it points at, as the Act stage does. */
    const collect = async (rating: { severity: number; importance: number } | null = { severity: 3, importance: 3 }) => {
      count += 1;
      const [row] = await db
        .insert(item)
        .values({
          workspaceId,
          sourceId,
          externalId: String(count),
          title: `Item ${String(count)}`,
          body: "An entry.",
          raw: {},
          capturedAt: new Date(saved.getTime() + count * 1000),
          ...rating,
        })
        .returning();
      const itemId = present(row).id;
      // Only the confirmed Destinations, as the Act stage collects only for those.
      const confirmed = await db
        .select({ id: actionDestination.destinationId })
        .from(actionDestination)
        .innerJoin(destination, eq(destination.id, actionDestination.destinationId))
        .where(and(eq(actionDestination.actionId, actionId), isNotNull(destination.confirmedAt)));
      await db.insert(digestItem).values(confirmed.map(({ id }) => ({ actionId, itemId, destinationId: id })));
      return itemId;
    };
    const logOf = (itemId: string) =>
      db.select({ message: itemLog.message, data: itemLog.data }).from(itemLog).where(eq(itemLog.itemId, itemId));
    const pending = () => db.$count(digestItem, eq(digestItem.actionId, actionId));
    const pendingFor = (destinationId: string) =>
      db.$count(digestItem, and(eq(digestItem.actionId, actionId), eq(digestItem.destinationId, destinationId)));
    return { workspaceId, actionId, inbox, addDestination, point, collect, logOf, pending, pendingFor };
  }

  const deps = (senders: DigestDeps["senders"], now: Date, extra: Partial<DigestDeps> = {}): DigestDeps => ({
    senders,
    appUrl,
    secret,
    now: () => now,
    ...extra,
  });

  it("is due at 08:00 Moscow time on 0 8 * * *, and not again until the next day after it runs", async () => {
    const { actionId } = await seed();
    const minuteBefore = new Date(eightInMoscow.getTime() - 60_000);

    expect(await dueDigests(db, minuteBefore)).not.toContain(actionId);
    expect(await dueDigests(db, eightInMoscow)).toContain(actionId);

    await sendDigest(db, actionId, deps(recordingSenders().senders, eightInMoscow));
    const nextDay = new Date(eightInMoscow.getTime() + 24 * 60 * 60_000);
    expect(await dueDigests(db, new Date(nextDay.getTime() - 60_000))).not.toContain(actionId);
    expect(await dueDigests(db, nextDay)).toContain(actionId);
  });

  it("keeps a Telegram chat's new id when its group became a supergroup", async () => {
    const { actionId, inbox, collect } = await seed();
    await collect();
    const moving: Sender = { send: async (_target, _message, onChatMoved) => onChatMoved?.("new-chat-ciphertext") };

    await sendDigest(db, actionId, deps({ telegram: moving, email: moving }, eightInMoscow));

    const [kept] = await db.select().from(destination).where(eq(destination.id, inbox));
    expect(kept?.secretCiphertext).toBe("new-chat-ciphertext");
  });

  it("isn't due while disabled", async () => {
    const { actionId } = await seed();
    await db.update(action).set({ enabled: false, updatedAt: saved }).where(eq(action.id, actionId));
    expect(await dueDigests(db, eightInMoscow)).not.toContain(actionId);
  });

  it("sends nothing and writes nothing when it has collected nothing", async () => {
    const { actionId, inbox } = await seed();
    const { sent, senders } = recordingSenders();
    const logRows = await db.$count(itemLog);

    await sendDigest(db, actionId, deps(senders, eightInMoscow));

    expect(sent).toEqual([]);
    expect(await db.$count(itemLog)).toBe(logRows);
    expect(await db.$count(sentMessage, eq(sentMessage.destinationId, inbox))).toBe(0);
  });

  it("sends its Items once, ordered as Top, with a Log row on each, and empties itself", async () => {
    const { actionId, inbox, collect, logOf, pending } = await seed();
    const low = await collect({ severity: 1, importance: 1 });
    const unrated = await collect(null);
    const high = await collect({ severity: 5, importance: 5 });
    const { sent, senders } = recordingSenders();

    await sendDigest(db, actionId, deps(senders, eightInMoscow));

    expect(sent).toHaveLength(1);
    const [message] = sent;
    expect(message?.message.digest).toBe("Morning");
    expect(message?.message.count).toBe(3);
    expect(message?.message.lines.map(({ link }) => link)).toEqual([high, low, unrated].map((id) => `${appUrl}/items/${id}`));
    expect(checkUnsubscribeToken(new URL(present(message?.message.unsubscribeUrl)).searchParams.get("token") ?? "", secret)).toEqual({
      actionId,
      destinationId: inbox,
    });
    expect(await logOf(high)).toEqual([
      { message: "Sent in the Digest Morning to inbox", data: { actionId, destinationId: inbox, destination: "inbox", digest: "sent" } },
    ]);
    expect(await pending()).toBe(0);
    expect(await db.$count(sentMessage, eq(sentMessage.destinationId, inbox))).toBe(1);

    // The next firing has nothing left to send.
    await sendDigest(db, actionId, deps(senders, new Date(eightInMoscow.getTime() + 24 * 60 * 60_000)));
    expect(sent).toHaveLength(1);
  });

  it("lists 50 of 51 Items and counts the 51st into 'and 1 more', which is sent too", async () => {
    const { actionId, collect, logOf, pending } = await seed();
    const ids: string[] = [];
    for (let i = 0; i < 51; i++) ids.push(await collect());
    const { sent, senders } = recordingSenders();

    await sendDigest(db, actionId, deps(senders, eightInMoscow));

    const [message] = sent;
    expect(message?.message.count).toBe(51);
    expect(message?.message.lines).toHaveLength(50);
    expect(await pending()).toBe(0);
    // The newest is listed first among equals, so the oldest is the one past the 50th line.
    expect(await logOf(present(ids[0]))).toEqual([expect.objectContaining({ message: "Sent in the Digest Morning to inbox" })]);
  });

  it("sends 50 Items with nothing more", async () => {
    const { actionId, collect } = await seed();
    for (let i = 0; i < 50; i++) await collect();
    const { sent, senders } = recordingSenders();

    await sendDigest(db, actionId, deps(senders, eightInMoscow));

    expect(sent[0]?.message.count).toBe(50);
    expect(sent[0]?.message.lines).toHaveLength(50);
  });

  it("keeps the Items when nothing went, and writes only the failure, with the next Digest's time", async () => {
    const { actionId, inbox, addDestination, point, collect, logOf, pending } = await seed();
    await point(await addDestination("waiting", { confirmedAt: null }));
    const itemId = await collect();
    const { sent, senders } = recordingSenders(["inbox"]);

    await sendDigest(db, actionId, deps(senders, eightInMoscow));

    expect(sent).toEqual([]);
    expect((await logOf(itemId)).map(({ message }) => message)).toEqual([
      "Sending the Digest Morning to inbox failed: the mail server can't be reached. It waits for the next Digest, at 08:00 (Europe/Moscow)",
    ]);
    expect(await pending()).toBe(1);
    const [failed] = await db.select({ lastError: destination.lastError }).from(destination).where(eq(destination.id, inbox));
    expect(failed?.lastError).toBe("the mail server can't be reached");
    // Its place in the hosted count is given back.
    expect(await db.$count(sentMessage, eq(sentMessage.destinationId, inbox))).toBe(0);
  });

  it("writes a failed and a skipped Destination once when another got the Digest, and the Items leave it", async () => {
    const { actionId, addDestination, point, collect, logOf, pending } = await seed();
    await point(await addDestination("backup"));
    await point(await addDestination("waiting", { confirmedAt: null }));
    const itemId = await collect();
    const { sent, senders } = recordingSenders(["backup"]);

    await sendDigest(db, actionId, deps(senders, eightInMoscow));

    expect(sent.map(({ to }) => to)).toEqual(["inbox"]);
    expect((await logOf(itemId)).map(({ message }) => message).sort()).toEqual([
      "Sending the Digest Morning to backup failed: the mail server can't be reached. It won't be sent again",
      "Sent in the Digest Morning to inbox",
      "Skipped waiting in the Digest Morning: not confirmed yet",
    ]);
    expect(await pending()).toBe(0);
  });

  it("sends to its chat and the address the day has room for, and holds the other address until the day ends", async () => {
    const { workspaceId, actionId, inbox, addDestination, point, collect, logOf, pending, pendingFor } = await seed();
    // Addresses go in name order, so "inbox" takes the day's last place and "work" is the one held.
    const work = await addDestination("work");
    const chat = await addDestination("chat", { type: "telegram", config: {} });
    await point(work);
    await point(chat);
    const itemId = await collect();
    const sentToday = (count: number) =>
      db.insert(sentMessage).values(
        Array.from({ length: count }, () => ({ workspaceId, destinationId: inbox, type: "email" as const, sentAt: eightInMoscow })),
      );
    const emailCap = { queueNotice: () => Promise.resolve() };
    const { sent, senders } = recordingSenders();

    await sentToday(49);
    await sendDigest(db, actionId, deps(senders, eightInMoscow, { emailCap }));

    // The chat isn't counted against the cap, and the day had room for one mail, which goes to the first
    // address by name. The other one keeps the firing's Items, and the time the cap ends.
    expect(sent.map(({ to }) => to).sort()).toEqual(["chat", "inbox"]);
    expect(sent.map(({ message }) => message.count)).toEqual([1, 1]);
    expect(await pendingFor(work)).toBe(1);
    expect(await pendingFor(inbox)).toBe(0);
    expect(await pendingFor(chat)).toBe(0);
    // Midnight in Moscow, the end of the local day the cap counted.
    const dayEnd = new Date("2026-11-03T21:00:00Z");
    const [held] = await db.select({ heldUntil: digestItem.heldUntil }).from(digestItem).where(eq(digestItem.destinationId, work));
    expect(present(held).heldUntil).toEqual(dayEnd);
    // The sweep finds it through the hold, not the schedule, so it goes before the next firing.
    expect(await dueDigests(db, new Date(dayEnd.getTime() - 60_000))).not.toContain(actionId);
    expect(await dueDigests(db, dayEnd)).toContain(actionId);

    await db.delete(sentMessage).where(eq(sentMessage.workspaceId, workspaceId));
    await sendDigest(db, actionId, deps(senders, dayEnd, { emailCap }));

    // The held address gets the Items of the firing it was held from, as that Digest.
    expect(sent.map(({ to }) => to).sort()).toEqual(["chat", "inbox", "work"]);
    expect(sent.map(({ message }) => message.count)).toEqual([1, 1, 1]);
    const toWork = present(sent.find(({ to }) => to === "work"));
    expect(toWork.message.lines.map(({ link }) => link)).toEqual([`${appUrl}/items/${itemId}`]);
    expect(await pending()).toBe(0);

    // The next firing's Items aren't the held ones, and don't repeat them to it.
    const next = await collect();
    await sendDigest(db, actionId, deps(senders, new Date(eightInMoscow.getTime() + 24 * 60 * 60_000), { emailCap }));
    expect(sent.slice(3).map(({ to }) => to).sort()).toEqual(["chat", "inbox", "work"]);
    expect(sent.slice(3).map(({ message }) => message.lines.map(({ link }) => link))).toEqual([
      [`${appUrl}/items/${next}`],
      [`${appUrl}/items/${next}`],
      [`${appUrl}/items/${next}`],
    ]);
    // One send per Destination per Item: the held Item doesn't go to the held address twice.
    expect((await logOf(itemId)).map(({ message }) => message).sort()).toEqual([
      "Sent in the Digest Morning to chat",
      "Sent in the Digest Morning to inbox",
      "Sent in the Digest Morning to work",
    ]);
  });

  it("holds every address of a Digest the hosted cap would pass, and queues the notice", async () => {
    const { workspaceId, actionId, inbox, collect, pending } = await seed();
    await collect();
    await db.insert(sentMessage).values(
      Array.from({ length: 50 }, () => ({ workspaceId, destinationId: inbox, type: "email" as const, sentAt: eightInMoscow })),
    );
    const notices: string[] = [];
    const { sent, senders } = recordingSenders();

    await sendDigest(
      db,
      actionId,
      deps(senders, eightInMoscow, {
        emailCap: {
          queueNotice: (_tx, id) => {
            notices.push(id);
            return Promise.resolve();
          },
        },
      }),
    );

    expect(sent).toEqual([]);
    expect(await pending()).toBe(1);
    expect(notices).toEqual([workspaceId]);
    // The firing ran, so the schedule doesn't come again today; the sweep finds the held Items at midnight.
    const dayEnd = new Date("2026-11-03T21:00:00Z");
    expect(await dueDigests(db, eightInMoscow)).not.toContain(actionId);
    expect(await dueDigests(db, dayEnd)).toContain(actionId);
  });

  it("keeps updated_at, which the Act stage compares with captured_at", async () => {
    const { actionId, collect } = await seed();
    await collect();

    await sendDigest(db, actionId, deps(recordingSenders().senders, eightInMoscow));

    const [row] = await db.select({ updatedAt: action.updatedAt, ranAt: action.digestRanAt }).from(action).where(eq(action.id, actionId));
    expect(row).toEqual({ updatedAt: saved, ranAt: eightInMoscow });
  });
});
