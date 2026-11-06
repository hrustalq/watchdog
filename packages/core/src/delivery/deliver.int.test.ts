import {
  action,
  actionDestination,
  closeDb,
  createDb,
  type Db,
  delivery,
  destination,
  eq,
  item,
  itemLog,
  migrate,
  source,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres, type TestPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { encryptSecret } from "../secrets/secrets.ts";
import { deliver, type Destination, FinalSendError, RetryAfterSendError, type Sender } from "./deliver.ts";
import type { AlertMessage } from "./content.ts";
import { createTelegramSender } from "./telegram.ts";

/** The value, which the test expects to be there. */
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}

const hour = 60 * 60 * 1000;

describe("deliver", () => {
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

  /** A queued Delivery of an alert about a rated Item, to a confirmed Destination named "ops-chat". */
  async function seed(itemValues: Partial<typeof item.$inferInsert> = {}) {
    const ownerId = crypto.randomUUID();
    await db.insert(user).values({ id: ownerId, name: "Owner", email: `${ownerId}@example.com` });
    const [ws] = await db.insert(workspace).values({ name: "Workspace", ownerUserId: ownerId }).returning();
    const workspaceId = present(ws).id;
    const [src] = await db
      .insert(source)
      .values({
        workspaceId,
        type: "rss",
        name: "Hacker News",
        config: { url: "https://feeds.test/hn.rss" },
        schedule: "*/15 * * * *",
      })
      .returning();
    const [captured] = await db
      .insert(item)
      .values({
        workspaceId,
        sourceId: present(src).id,
        externalId: "one",
        url: "https://news.test/one",
        title: "A security advisory",
        body: "An entry.",
        raw: {},
        summary: "Patch now.",
        severity: 5,
        importance: 3,
        ...itemValues,
      })
      .returning();
    const itemId = present(captured).id;
    const [chat] = await db
      .insert(destination)
      .values({ workspaceId, type: "telegram", name: "ops-chat", confirmedAt: new Date() })
      .returning();
    const destinationId = present(chat).id;
    const when = { field: "severity", op: "gte", value: 4 };
    const [saved] = await db
      .insert(action)
      .values({
        workspaceId,
        name: "critical",
        kind: "alert",
        definition: { action: "critical", when, kind: "alert", destinations: [destinationId] },
      })
      .returning();
    const actionId = present(saved).id;
    await db.insert(actionDestination).values({ actionId, destinationId });
    const [row] = await db.insert(delivery).values({ actionId, itemId, destinationId }).returning();
    return { ownerId, itemId, destinationId, actionId, deliveryId: present(row).id };
  }

  /** The deps, recording what the sender got and which retries were queued. */
  function recording(send: Sender["send"] = () => Promise.resolve()) {
    const sent: { destination: Destination; message: AlertMessage }[] = [];
    const retries: { deliveryId: string; at: Date }[] = [];
    const sender: Sender = {
      send: async (target, message) => {
        sent.push({ destination: target, message });
        await send(target, message);
      },
    };
    return {
      sent,
      retries,
      deps: {
        senders: { telegram: sender, email: sender, webhook: sender },
        appUrl: "https://watchdog.test",
        retryDelivery: (_tx: unknown, deliveryId: string, at: Date) => {
          retries.push({ deliveryId, at });
          return Promise.resolve();
        },
      },
    };
  }

  const rowOf = async (deliveryId: string) => db.query.delivery.findFirst({ where: eq(delivery.id, deliveryId) });
  const actLog = async (itemId: string) =>
    db.select().from(itemLog).where(eq(itemLog.itemId, itemId)).orderBy(itemLog.id);

  it("sends the alert through the Destination's type and records it as sent", async () => {
    const seeded = await seed();
    const { deps, sent } = recording();

    await deliver(db, seeded.deliveryId, deps);

    expect(sent).toHaveLength(1);
    expect(present(sent[0]).destination.id).toBe(seeded.destinationId);
    expect(present(sent[0]).message).toEqual({
      title: "A security advisory",
      source: "Hacker News",
      rating: "Severity 5, Importance 3",
      summary: "Patch now.",
      link: `https://watchdog.test/items/${seeded.itemId}`,
      why: "Severity is at least 4",
    });
    const row = await rowOf(seeded.deliveryId);
    expect(row).toMatchObject({ status: "sent", attempts: 1, nextAttemptAt: null, lastError: null });
    expect(row?.sentAt).not.toBeNull();
    expect(await actLog(seeded.itemId)).toMatchObject([
      {
        stage: "act",
        message: "Sent to ops-chat",
        data: { actionId: seeded.actionId, destinationId: seeded.destinationId, attempt: 1 },
      },
    ]);
  });

  it("uses only the sender for the Destination's type", async () => {
    const seeded = await seed();
    const { deps, sent } = recording();
    const refused = { send: () => Promise.reject(new Error("The wrong sender")) };

    await deliver(db, seeded.deliveryId, { ...deps, senders: { ...deps.senders, email: refused, webhook: refused } });

    expect(sent).toHaveLength(1);
    expect(await rowOf(seeded.deliveryId)).toMatchObject({ status: "sent" });
  });

  it("says an Item without a Rating or a title is unrated and untitled", async () => {
    const seeded = await seed({ title: null, summary: null, severity: null, importance: null });
    const { deps, sent } = recording();

    await deliver(db, seeded.deliveryId, deps);

    expect(present(sent[0]).message).toMatchObject({ title: "Untitled Item", rating: "unrated", summary: null });
  });

  it("names the Action as the reason when its definition no longer parses", async () => {
    const seeded = await seed();
    await db.update(action).set({ definition: { broken: true } }).where(eq(action.id, seeded.actionId));
    const { deps, sent } = recording();

    await deliver(db, seeded.deliveryId, deps);

    expect(present(sent[0]).message.why).toBe("Action critical fired");
  });

  it("retries a failing sender with growing delays, each attempt in the Log, then sends once", async () => {
    const seeded = await seed();
    let failures = 2;
    const { deps, sent, retries } = recording(() =>
      failures-- > 0 ? Promise.reject(new Error("Chat unreachable")) : Promise.resolve(),
    );
    const first = new Date("2026-01-07T10:00:00.000Z");
    const second = new Date("2026-01-07T10:00:30.000Z");
    const third = new Date("2026-01-07T10:01:30.000Z");
    await db.update(delivery).set({ createdAt: first }).where(eq(delivery.id, seeded.deliveryId));

    await deliver(db, seeded.deliveryId, { ...deps, now: () => first });
    expect(await rowOf(seeded.deliveryId)).toMatchObject({
      status: "queued",
      attempts: 1,
      nextAttemptAt: second,
      lastError: "Chat unreachable",
    });

    await deliver(db, seeded.deliveryId, { ...deps, now: () => second });
    expect(await rowOf(seeded.deliveryId)).toMatchObject({ status: "queued", attempts: 2, nextAttemptAt: third });

    await deliver(db, seeded.deliveryId, { ...deps, now: () => third });
    expect(await rowOf(seeded.deliveryId)).toMatchObject({
      status: "sent",
      attempts: 3,
      nextAttemptAt: null,
      lastError: null,
      sentAt: third,
    });

    expect(retries).toEqual([
      { deliveryId: seeded.deliveryId, at: second },
      { deliveryId: seeded.deliveryId, at: third },
    ]);
    expect(await actLog(seeded.itemId)).toMatchObject([
      {
        message: "Sending to ops-chat failed: Chat unreachable, retrying at 2026-01-07T10:00:30.000Z",
        data: { attempt: 1, retryAt: "2026-01-07T10:00:30.000Z" },
      },
      {
        message: "Sending to ops-chat failed: Chat unreachable, retrying at 2026-01-07T10:01:30.000Z",
        data: { attempt: 2, retryAt: "2026-01-07T10:01:30.000Z" },
      },
      { message: "Sent to ops-chat", data: { attempt: 3 } },
    ]);

    // Its job running again, for any reason, sends nothing.
    await deliver(db, seeded.deliveryId, { ...deps, now: () => third });
    expect(sent).toHaveLength(3);
    expect(await actLog(seeded.itemId)).toHaveLength(3);
  });

  it("makes the last retry when the Delivery turns 24 hours old, however long the backoff has grown", async () => {
    const seeded = await seed();
    const created = new Date("2026-01-07T10:00:00.000Z");
    await db.update(delivery).set({ createdAt: created, attempts: 11 }).where(eq(delivery.id, seeded.deliveryId));
    const { deps, retries } = recording(() => Promise.reject(new Error("Down")));
    const lateAttempt = new Date(created.getTime() + 20 * hour);

    await deliver(db, seeded.deliveryId, { ...deps, now: () => lateAttempt });

    const dayLater = new Date(created.getTime() + 24 * hour);
    expect(retries).toEqual([{ deliveryId: seeded.deliveryId, at: dayLater }]);
    expect(await rowOf(seeded.deliveryId)).toMatchObject({ status: "queued", attempts: 12, nextAttemptAt: dayLater });
  });

  it("fails the Delivery after 24 hours of failures: the Log says so and the Destination shows the error", async () => {
    const seeded = await seed();
    const now = new Date();
    await db
      .update(delivery)
      .set({ createdAt: new Date(now.getTime() - 24 * hour), attempts: 12 })
      .where(eq(delivery.id, seeded.deliveryId));
    const { deps, retries } = recording(() => Promise.reject(new Error("Chat unreachable")));

    await deliver(db, seeded.deliveryId, { ...deps, now: () => now });

    expect(retries).toEqual([]);
    expect(await rowOf(seeded.deliveryId)).toMatchObject({
      status: "failed",
      attempts: 13,
      nextAttemptAt: null,
      lastError: "Chat unreachable",
    });
    expect(await actLog(seeded.itemId)).toMatchObject([
      {
        message: "Sending to ops-chat failed: Chat unreachable. No more retries after 24 hours",
        data: { attempt: 13, final: true },
      },
    ]);
    const shown = await db.query.destination.findFirst({ where: eq(destination.id, seeded.destinationId) });
    expect(shown).toMatchObject({ lastError: "Chat unreachable", lastErrorAt: now });
  });

  it("fails a Delivery at once when the sender says no retry can work", async () => {
    const seeded = await seed();
    const now = new Date();
    const { deps, retries } = recording(() => Promise.reject(new FinalSendError("Refused for good")));

    await deliver(db, seeded.deliveryId, { ...deps, now: () => now });

    expect(retries).toEqual([]);
    expect(await rowOf(seeded.deliveryId)).toMatchObject({
      status: "failed",
      attempts: 1,
      nextAttemptAt: null,
      lastError: "Refused for good",
    });
    expect(await actLog(seeded.itemId)).toMatchObject([
      { message: "Sending to ops-chat failed: Refused for good. It won't be retried", data: { attempt: 1, final: true } },
    ]);
    const shown = await db.query.destination.findFirst({ where: eq(destination.id, seeded.destinationId) });
    expect(shown).toMatchObject({ lastError: "Refused for good", lastErrorAt: now });
  });

  it("waits as long as the sender was told to, in place of the backoff", async () => {
    const seeded = await seed();
    const now = new Date();
    // The backoff at this attempt would be hours, and the wait is seconds.
    await db.update(delivery).set({ attempts: 8 }).where(eq(delivery.id, seeded.deliveryId));
    const { deps, retries } = recording(() => Promise.reject(new RetryAfterSendError("Slow down", 5000)));

    await deliver(db, seeded.deliveryId, { ...deps, now: () => now });

    const retryAt = new Date(now.getTime() + 5000);
    expect(retries).toEqual([{ deliveryId: seeded.deliveryId, at: retryAt }]);
    expect(await rowOf(seeded.deliveryId)).toMatchObject({
      status: "queued",
      attempts: 9,
      nextAttemptAt: retryAt,
      lastError: "Slow down",
    });
    expect(await actLog(seeded.itemId)).toMatchObject([
      { message: `Sending to ops-chat failed: Slow down, retrying at ${retryAt.toISOString()}` },
    ]);
  });

  it("keeps a wait the sender was told to make even past the 24 hour mark", async () => {
    const seeded = await seed();
    const created = new Date("2026-01-07T10:00:00.000Z");
    await db.update(delivery).set({ createdAt: created }).where(eq(delivery.id, seeded.deliveryId));
    const late = new Date(created.getTime() + 24 * hour - 1000);
    const { deps, retries } = recording(() => Promise.reject(new RetryAfterSendError("Slow down", 5000)));

    await deliver(db, seeded.deliveryId, { ...deps, now: () => late });

    expect(retries).toEqual([{ deliveryId: seeded.deliveryId, at: new Date(late.getTime() + 5000) }]);
  });

  it("stops at the 24 hour mark however long the sender was told to wait", async () => {
    const seeded = await seed();
    const now = new Date();
    await db
      .update(delivery)
      .set({ createdAt: new Date(now.getTime() - 24 * hour) })
      .where(eq(delivery.id, seeded.deliveryId));
    const { deps, retries } = recording(() => Promise.reject(new RetryAfterSendError("Slow down", 5000)));

    await deliver(db, seeded.deliveryId, { ...deps, now: () => now });

    expect(retries).toEqual([]);
    expect(await rowOf(seeded.deliveryId)).toMatchObject({ status: "failed", nextAttemptAt: null });
  });

  describe("through the Telegram sender, with a fake Telegram API", () => {
    const encryptionKey = Buffer.alloc(32, 7);
    const sentMessage = z.object({ chat_id: z.string(), text: z.string() });

    /** A Delivery to a linked chat, and deps that send it through the real sender to a fake API. */
    async function linked(answer: () => Response) {
      const seeded = await seed();
      await db
        .update(destination)
        .set({ secretCiphertext: encryptSecret("-100200", encryptionKey) })
        .where(eq(destination.id, seeded.destinationId));
      const received: z.output<typeof sentMessage>[] = [];
      const telegram = createTelegramSender("123456:token", {
        fetch: (_input, init) => {
          received.push(sentMessage.parse(JSON.parse(typeof init?.body === "string" ? init.body : "")));
          return Promise.resolve(answer());
        },
        encryptionKey,
      });
      const { deps, retries } = recording();
      return { seeded, received, retries, deps: { ...deps, senders: { ...deps.senders, telegram } } };
    }

    it("sends a queued Delivery to the linked chat with the Item's title and link", async () => {
      const { seeded, received, deps } = await linked(() => Response.json({ ok: true, result: {} }));

      await deliver(db, seeded.deliveryId, deps);

      expect(await rowOf(seeded.deliveryId)).toMatchObject({ status: "sent", attempts: 1, lastError: null });
      expect(received).toHaveLength(1);
      expect(present(received[0]).chat_id).toBe("-100200");
      expect(present(received[0]).text).toContain("A security advisory");
      expect(present(received[0]).text).toContain(`https://watchdog.test/items/${seeded.itemId}`);
    });

    it("sets next_attempt_at at least 5 seconds out on a 429 with retry_after: 5", async () => {
      const { seeded, retries, deps } = await linked(() =>
        Response.json({ ok: false, error_code: 429, parameters: { retry_after: 5 } }, { status: 429 }),
      );
      const before = Date.now();

      await deliver(db, seeded.deliveryId, deps);

      const row = present(await rowOf(seeded.deliveryId));
      expect(row.status).toBe("queued");
      expect(row.nextAttemptAt?.getTime()).toBeGreaterThanOrEqual(before + 5000);
      expect(row.nextAttemptAt?.getTime()).toBeLessThan(before + 30_000);
      expect(present(retries[0]).at).toEqual(row.nextAttemptAt);
    });

    it("ends the Delivery as failed with no retry on a 403, and the Destination says the bot was removed", async () => {
      const { seeded, retries, deps } = await linked(() =>
        Response.json(
          { ok: false, error_code: 403, description: "Forbidden: bot was kicked from the group chat" },
          { status: 403 },
        ),
      );

      await deliver(db, seeded.deliveryId, deps);

      expect(retries).toEqual([]);
      expect(await rowOf(seeded.deliveryId)).toMatchObject({ status: "failed", attempts: 1, nextAttemptAt: null });
      const shown = await db.query.destination.findFirst({ where: eq(destination.id, seeded.destinationId) });
      expect(shown?.lastError).toMatch(/bot was removed from the chat/);
    });

    it("writes a Log row saying the bot isn't set up when there's no token", async () => {
      const seeded = await seed();
      const telegram = createTelegramSender(undefined, {
        fetch: () => Promise.reject(new Error("Nothing should call Telegram")),
        encryptionKey,
      });
      const { deps } = recording();

      await deliver(db, seeded.deliveryId, { ...deps, senders: { ...deps.senders, telegram } });

      const [row] = await actLog(seeded.itemId);
      expect(row?.message).toMatch(/^Sending to ops-chat failed: the Telegram bot isn't set up/);
    });
  });

  it("clears the Destination's error when a later send works", async () => {
    const seeded = await seed();
    await db
      .update(destination)
      .set({ lastError: "Chat unreachable", lastErrorAt: new Date() })
      .where(eq(destination.id, seeded.destinationId));
    const { deps } = recording();

    await deliver(db, seeded.deliveryId, deps);

    const shown = await db.query.destination.findFirst({ where: eq(destination.id, seeded.destinationId) });
    expect(shown).toMatchObject({ lastError: null, lastErrorAt: null });
  });

  it("leaves a Delivery alone until its next attempt is due, because that attempt's job is waiting", async () => {
    const seeded = await seed();
    await db
      .update(delivery)
      .set({ attempts: 7, nextAttemptAt: new Date(Date.now() + hour) })
      .where(eq(delivery.id, seeded.deliveryId));
    const { deps, sent, retries } = recording();

    // The job that recorded attempt 7, run again because its worker died before finishing it.
    await deliver(db, seeded.deliveryId, deps);

    expect(sent).toEqual([]);
    expect(retries).toEqual([]);
    expect(await rowOf(seeded.deliveryId)).toMatchObject({ status: "queued", attempts: 7 });
  });

  it("records nothing, and queues no second retry, when another job recorded this attempt during the send", async () => {
    const seeded = await seed();
    const { deps, retries } = recording(async () => {
      await db.update(delivery).set({ attempts: 1 }).where(eq(delivery.id, seeded.deliveryId));
      throw new Error("Down");
    });

    await deliver(db, seeded.deliveryId, deps);

    expect(retries).toEqual([]);
    expect(await actLog(seeded.itemId)).toEqual([]);
  });

  it("still tries once a Delivery that a long outage kept waiting past 24 hours", async () => {
    const seeded = await seed();
    await db
      .update(delivery)
      .set({ createdAt: new Date(Date.now() - 30 * hour) })
      .where(eq(delivery.id, seeded.deliveryId));
    const { deps } = recording();

    await deliver(db, seeded.deliveryId, deps);

    expect(await rowOf(seeded.deliveryId)).toMatchObject({ status: "sent", attempts: 1 });
  });

  it("keeps the retry time in a Log row whatever the reason's length, and stores a reason Postgres can hold", async () => {
    const seeded = await seed();
    const { deps, retries } = recording(() => Promise.reject(new Error(`Down\0${"x".repeat(5000)}`)));

    await deliver(db, seeded.deliveryId, deps);

    const [row] = await actLog(seeded.itemId);
    expect(row?.message).toContain(`retrying at ${present(retries[0]).at.toISOString()}`);
    const stored = await rowOf(seeded.deliveryId);
    expect(stored?.lastError).toMatch(/^Downx+$/);
  });

  it("records nothing of an attempt whose retry couldn't be queued, so the job's own retry repeats it", async () => {
    const seeded = await seed();
    const { deps } = recording(() => Promise.reject(new Error("Down")));

    await expect(
      deliver(db, seeded.deliveryId, { ...deps, retryDelivery: () => Promise.reject(new Error("Queue down")) }),
    ).rejects.toThrow("Queue down");

    expect(await rowOf(seeded.deliveryId)).toMatchObject({ status: "queued", attempts: 0, lastError: null });
    expect(await actLog(seeded.itemId)).toEqual([]);
  });

  it.each(["held", "grouped", "sent", "failed"] as const)("skips a %s Delivery", async (status) => {
    const seeded = await seed();
    await db.update(delivery).set({ status }).where(eq(delivery.id, seeded.deliveryId));
    const { deps, sent, retries } = recording();

    await deliver(db, seeded.deliveryId, deps);

    expect(sent).toEqual([]);
    expect(retries).toEqual([]);
    expect(await rowOf(seeded.deliveryId)).toMatchObject({ status, attempts: 0 });
    expect(await actLog(seeded.itemId)).toEqual([]);
  });

  it("finds nothing to do once the Item is deleted", async () => {
    const seeded = await seed();
    await db.delete(item).where(eq(item.id, seeded.itemId));
    const { deps, sent } = recording();

    await deliver(db, seeded.deliveryId, deps);

    expect(sent).toEqual([]);
  });

  it("finds nothing to do once the Destination is deleted with its Workspace", async () => {
    const seeded = await seed();
    await db.delete(user).where(eq(user.id, seeded.ownerId));
    const { deps, sent } = recording();

    await deliver(db, seeded.deliveryId, deps);

    expect(sent).toEqual([]);
  });

  it.each([
    ["succeeds", () => Promise.resolve()],
    ["fails", () => Promise.reject(new Error("Down"))],
  ])("ends quietly when the Item is deleted during a send that %s", async (_name, outcome) => {
    const seeded = await seed();
    const { deps, retries } = recording(async () => {
      await db.delete(item).where(eq(item.id, seeded.itemId));
      await outcome();
    });

    await deliver(db, seeded.deliveryId, deps);

    expect(retries).toEqual([]);
    expect(await rowOf(seeded.deliveryId)).toBeUndefined();
  });
});
