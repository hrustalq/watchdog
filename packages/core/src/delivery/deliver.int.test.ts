import { createServer, type IncomingHttpHeaders } from "node:http";
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
  itemCategory,
  itemField,
  itemLog,
  migrate,
  source,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres, type TestPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createEgressFetch } from "../egress/egress.ts";
import { encryptSecret } from "../secrets/secrets.ts";
import { deliver, type Destination, FinalSendError, RetryAfterSendError, type Sender } from "./deliver.ts";
import type { AlertMessage, WebhookMessage } from "./content.ts";
import type { GroupedAlert } from "./group.ts";
import { createTelegramSender } from "./telegram.ts";
import { verifyWebhookSignature } from "./verify-signature.ts";
import { createWebhookSender } from "./webhook.ts";

/** The value, which the test expects to be there. */
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}

const hour = 60 * 60 * 1000;

type AnyMessage = AlertMessage | GroupedAlert | WebhookMessage;

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
    return {
      ownerId,
      workspaceId,
      sourceId: present(src).id,
      itemId,
      destinationId,
      actionId,
      deliveryId: present(row).id,
    };
  }

  /** The deps, recording what the sender got and which retries were queued. */
  function recording(send: Sender<AnyMessage>["send"] = () => Promise.resolve()) {
    const sent: { destination: Destination; message: AnyMessage }[] = [];
    const retries: { deliveryId: string; at: Date }[] = [];
    const sender: Sender<AnyMessage> = {
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
      severity: 5,
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

    expect(present(sent[0]).message).toMatchObject({ why: "Action critical fired" });
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

  describe("through the webhook sender and the egress guard, with a local receiver", () => {
    const encryptionKey = Buffer.alloc(32, 7);
    const secret = "a-webhook-secret";
    const answer = { status: 204, text: "" };
    const received: { headers: IncomingHttpHeaders; method: string | undefined; body: string }[] = [];
    let port: number;

    beforeAll(async () => {
      // On 127.0.0.1, which only `receiver.test` is allowlisted to reach, as in the egress guard's own tests.
      const receiver = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          received.push({
            headers: request.headers,
            method: request.method,
            body: Buffer.concat(chunks).toString(),
          });
          response.statusCode = answer.status;
          response.end(answer.text);
        });
      });
      await new Promise<void>((listening) => receiver.listen(0, "127.0.0.1", listening));
      port = z.object({ port: z.number() }).parse(receiver.address()).port;
      return () => void receiver.close();
    });

    const webhook = createWebhookSender({
      encryptionKey,
      fetch: createEgressFetch(
        { mode: "self-hosted", egressAllowlist: [{ type: "host", host: "receiver.test" }] },
        {
          lookup: (host) =>
            Promise.resolve([{ address: host === "receiver.test" ? "127.0.0.1" : "10.0.0.5", family: 4 }]),
        },
      ),
    });

    /** A Delivery to a webhook Destination, and deps that send it through the real sender. */
    async function hook(itemValues: Partial<typeof item.$inferInsert> = {}, host = "receiver.test") {
      received.length = 0;
      Object.assign(answer, { status: 204, text: "" });
      const seeded = await seed(itemValues);
      await db
        .update(destination)
        .set({
          type: "webhook",
          config: { url: `http://${host}:${String(port)}/hook` },
          secretCiphertext: encryptSecret(secret, encryptionKey),
        })
        .where(eq(destination.id, seeded.destinationId));
      const { deps, retries } = recording();
      return { seeded, retries, deps: { ...deps, senders: { ...deps.senders, webhook } } };
    }

    it("sends a delivery a receiver can verify, and whose changed body it rejects", async () => {
      const { seeded, deps } = await hook();

      await deliver(db, seeded.deliveryId, deps);

      expect(received).toHaveLength(1);
      const [request] = received;
      const timestamp = z.string().parse(request?.headers["x-watchdog-timestamp"]);
      const signature = z.string().parse(request?.headers["x-watchdog-signature"]);
      const body = request?.body ?? "";
      expect(request?.method).toBe("POST");
      expect(request?.headers["content-type"]).toBe("application/json");
      expect(request?.headers["user-agent"]).toBe("Watchdog");
      expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
      expect(verifyWebhookSignature({ secret, timestamp, body, signature })).toBe(true);
      expect(verifyWebhookSignature({ secret, timestamp, body: body.replace("Patch", "Ignore"), signature })).toBe(false);
      expect(await rowOf(seeded.deliveryId)).toMatchObject({ status: "sent", attempts: 1 });
      expect(await actLog(seeded.itemId)).toMatchObject([{ message: "Sent to ops-chat" }]);
    });

    it("sends the body the docs describe, with the Item's Categories and fields and without raw", async () => {
      const { seeded, deps } = await hook({
        raw: { private: "the Source's own payload" },
        publishedAt: new Date("2026-11-07T10:00:00.000Z"),
        capturedAt: new Date("2026-11-07T10:05:00.000Z"),
      });
      await db.insert(itemCategory).values({ itemId: seeded.itemId, category: "security-advisory" });
      // A jsonb string that reads as a number has to stay a string.
      await db.insert(itemField).values([
        { itemId: seeded.itemId, name: "cve", value: "CVE-2026-1" },
        { itemId: seeded.itemId, name: "version", value: "2" },
        { itemId: seeded.itemId, name: "count", value: 3 },
      ]);

      await deliver(db, seeded.deliveryId, deps);

      const body = received[0]?.body ?? "";
      expect(body).not.toContain("the Source's own payload");
      expect(JSON.parse(body)).toEqual({
        version: 1,
        action: "critical",
        item: {
          id: seeded.itemId,
          sourceId: seeded.sourceId,
          externalId: "one",
          url: "https://news.test/one",
          title: "A security advisory",
          author: null,
          body: "An entry.",
          publishedAt: "2026-11-07T10:00:00.000Z",
          capturedAt: "2026-11-07T10:05:00.000Z",
          language: null,
          isBackfill: false,
          summary: "Patch now.",
        },
        rating: { severity: 5, importance: 3 },
        categories: ["security-advisory"],
        fields: { cve: "CVE-2026-1", version: "2", count: 3 },
        firedBecause: "Severity is at least 4",
      });
    });

    it("sends a null rating for an unrated Item", async () => {
      const { seeded, deps } = await hook({ severity: null, importance: null });

      await deliver(db, seeded.deliveryId, deps);

      expect(JSON.parse(received[0]?.body ?? "")).toMatchObject({ rating: null });
      expect(await rowOf(seeded.deliveryId)).toMatchObject({ status: "sent" });
    });

    it("retries a 500, and sends again with a new signature when the receiver recovers", async () => {
      const { seeded, retries, deps } = await hook();
      answer.status = 500;
      const failedAt = new Date();

      await deliver(db, seeded.deliveryId, { ...deps, now: () => failedAt });

      const retryAt = new Date(failedAt.getTime() + 30_000);
      expect(retries).toEqual([{ deliveryId: seeded.deliveryId, at: retryAt }]);
      expect(await rowOf(seeded.deliveryId)).toMatchObject({ status: "queued", attempts: 1, nextAttemptAt: retryAt });
      expect(await actLog(seeded.itemId)).toMatchObject([
        { message: `Sending to ops-chat failed: the receiver answered 500, retrying at ${retryAt.toISOString()}` },
      ]);

      answer.status = 200;
      await db.update(delivery).set({ nextAttemptAt: new Date(0) }).where(eq(delivery.id, seeded.deliveryId));
      await deliver(db, seeded.deliveryId, deps);

      expect(received).toHaveLength(2);
      const [, second] = received;
      expect(
        verifyWebhookSignature({
          secret,
          timestamp: z.string().parse(second?.headers["x-watchdog-timestamp"]),
          body: second?.body ?? "",
          signature: z.string().parse(second?.headers["x-watchdog-signature"]),
        }),
      ).toBe(true);
      expect(await rowOf(seeded.deliveryId)).toMatchObject({ status: "sent", attempts: 2 });
    });

    it("fails a 404 at once with the status in the Log and on the Destination, and keeps none of its answer", async () => {
      const { seeded, retries, deps } = await hook();
      Object.assign(answer, { status: 404, text: "the receiver's private data" });

      await deliver(db, seeded.deliveryId, deps);

      expect(retries).toEqual([]);
      const row = await rowOf(seeded.deliveryId);
      expect(row).toMatchObject({ status: "failed", attempts: 1, nextAttemptAt: null });
      const log = await actLog(seeded.itemId);
      expect(log).toMatchObject([
        { message: "Sending to ops-chat failed: the receiver answered 404. It won't be retried" },
      ]);
      const target = await db.query.destination.findFirst({ where: eq(destination.id, seeded.destinationId) });
      expect(target?.lastError).toBe("the receiver answered 404");
      expect(JSON.stringify([row, log, target])).not.toContain("private data");
    });

    it("fails a URL that resolves to a private address at once, without reaching the receiver", async () => {
      const { seeded, retries, deps } = await hook({}, "internal.test");

      await deliver(db, seeded.deliveryId, deps);

      expect(received).toEqual([]);
      expect(retries).toEqual([]);
      expect(await rowOf(seeded.deliveryId)).toMatchObject({ status: "failed", attempts: 1 });
      const reason = "the URL is a private, local or non-web address, which Watchdog doesn't call";
      expect(await actLog(seeded.itemId)).toMatchObject([
        { message: `Sending to ops-chat failed: ${reason}. It won't be retried` },
      ]);
      const target = await db.query.destination.findFirst({ where: eq(destination.id, seeded.destinationId) });
      expect(target?.lastError).toBe(reason);
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

  describe("before a send", () => {
    // In the future, so a waiting Delivery isn't due by the database's clock until a test says so.
    const at = (time: string) => new Date(`2099-01-07T${time}Z`);
    const clock = (time: string) => () => at(time);
    const settings = (workspaceId: string, values: Partial<typeof workspace.$inferInsert>) =>
      db.update(workspace).set(values).where(eq(workspace.id, workspaceId));
    const overnight = { quietHoursStart: "22:00:00", quietHoursEnd: "07:00:00" };
    /** What the sweep does when a waiting Delivery's time comes. */
    const release = (deliveryId: string) =>
      db.update(delivery).set({ status: "queued", nextAttemptAt: null }).where(eq(delivery.id, deliveryId));

    /** Another queued alert of the same Action to the same Destination, about a new Item. */
    async function another(seeded: Awaited<ReturnType<typeof seed>>, itemValues: Partial<typeof item.$inferInsert> = {}) {
      const [captured] = await db
        .insert(item)
        .values({
          workspaceId: seeded.workspaceId,
          sourceId: seeded.sourceId,
          externalId: crypto.randomUUID(),
          title: "Another advisory",
          body: "An entry.",
          raw: {},
          severity: 4,
          importance: 3,
          ...itemValues,
        })
        .returning();
      const itemId = present(captured).id;
      const [row] = await db
        .insert(delivery)
        .values({ actionId: seeded.actionId, itemId, destinationId: seeded.destinationId })
        .returning();
      return { itemId, deliveryId: present(row).id };
    }

    /** A message to the seeded Destination that went out at this time. */
    async function sentEarlier(
      seeded: Awaited<ReturnType<typeof seed>>,
      sentAt: Date,
      values: Partial<typeof delivery.$inferInsert> = {},
    ) {
      const { deliveryId } = await another(seeded);
      await db.update(delivery).set({ status: "sent", sentAt, ...values }).where(eq(delivery.id, deliveryId));
    }

    describe("quiet hours", () => {
      it("holds a Severity 4 alert until they end, and says so in the Log", async () => {
        const seeded = await seed({ severity: 4 });
        await settings(seeded.workspaceId, overnight);
        const { deps, sent, retries } = recording();

        await deliver(db, seeded.deliveryId, { ...deps, now: clock("23:00:00") });

        expect(sent).toEqual([]);
        expect(retries).toEqual([]);
        expect(await rowOf(seeded.deliveryId)).toMatchObject({
          status: "held",
          attempts: 0,
          nextAttemptAt: new Date("2099-01-08T07:00:00Z"),
        });
        expect(await actLog(seeded.itemId)).toMatchObject([
          { stage: "act", message: "Held until 07:00: quiet hours" },
        ]);
      });

      it("sends a Severity 5 alert now when the bypass is on", async () => {
        const seeded = await seed({ severity: 5 });
        await settings(seeded.workspaceId, { ...overnight, severity5BypassesQuietHours: true });
        const { deps, sent } = recording();

        await deliver(db, seeded.deliveryId, { ...deps, now: clock("23:00:00") });

        expect(sent).toHaveLength(1);
        expect(await rowOf(seeded.deliveryId)).toMatchObject({ status: "sent" });
      });

      it("sends the bypassing alert and holds the rest when they're due together", async () => {
        const seeded = await seed({ severity: 5 });
        await settings(seeded.workspaceId, { ...overnight, severity5BypassesQuietHours: true });
        const rest = await another(seeded, { severity: 4 });
        const { deps, sent } = recording();

        await deliver(db, seeded.deliveryId, { ...deps, now: clock("23:00:00") });

        expect(sent).toHaveLength(1);
        expect(present(sent[0]).message).toMatchObject({ title: "A security advisory" });
        expect(await rowOf(rest.deliveryId)).toMatchObject({ status: "held" });
      });

      it("sends a held alert once they have ended", async () => {
        const seeded = await seed({ severity: 4 });
        await settings(seeded.workspaceId, overnight);
        const { deps, sent } = recording();
        await deliver(db, seeded.deliveryId, { ...deps, now: clock("23:00:00") });

        await release(seeded.deliveryId);
        await deliver(db, seeded.deliveryId, { ...deps, now: clock("07:00:00") });

        expect(sent).toHaveLength(1);
        expect(await rowOf(seeded.deliveryId)).toMatchObject({ status: "sent", attempts: 1 });
      });

      it("gives a held alert its full 24 hours of retries from when its hold ended", async () => {
        const seeded = await seed({ severity: 4 });
        await settings(seeded.workspaceId, overnight);
        // Created long before the end of its hold, which is all of its 24 hours.
        const created = new Date("2099-01-07T06:00:00Z");
        await db.update(delivery).set({ createdAt: created }).where(eq(delivery.id, seeded.deliveryId));
        const { deps, retries } = recording(() => Promise.reject(new Error("Down")));
        await deliver(db, seeded.deliveryId, { ...deps, now: clock("23:00:00") });

        await release(seeded.deliveryId);
        const holdEnd = new Date("2099-01-08T07:00:00Z");
        await deliver(db, seeded.deliveryId, { ...deps, now: () => holdEnd });

        expect(await rowOf(seeded.deliveryId)).toMatchObject({ status: "queued", attempts: 1 });
        expect(retries).toEqual([{ deliveryId: seeded.deliveryId, at: new Date(holdEnd.getTime() + 30_000) }]);

        // Its last retry lands 24 hours after the hold ended, and a failure then is final. Quiet hours
        // go off so that no later check holds it again.
        await settings(seeded.workspaceId, { quietHoursStart: null, quietHoursEnd: null });
        await db.update(delivery).set({ nextAttemptAt: null, attempts: 11 }).where(eq(delivery.id, seeded.deliveryId));
        const nearEnd = new Date(holdEnd.getTime() + 20 * hour);
        await deliver(db, seeded.deliveryId, { ...deps, now: () => nearEnd });
        expect(present(retries[1]).at).toEqual(new Date(holdEnd.getTime() + 24 * hour));

        await db.update(delivery).set({ nextAttemptAt: null }).where(eq(delivery.id, seeded.deliveryId));
        await deliver(db, seeded.deliveryId, { ...deps, now: () => new Date(holdEnd.getTime() + 24 * hour) });
        expect(await rowOf(seeded.deliveryId)).toMatchObject({ status: "failed" });
      });

      it("takes a timezone change into account on the next check", async () => {
        const seeded = await seed({ severity: 4 });
        await settings(seeded.workspaceId, overnight);
        const { deps, sent } = recording();
        await deliver(db, seeded.deliveryId, { ...deps, now: clock("23:00:00") });
        expect(sent).toEqual([]);

        // 01:00 UTC is still quiet in UTC, and 10:00 in Tokyo isn't.
        await settings(seeded.workspaceId, { timezone: "Asia/Tokyo" });
        await release(seeded.deliveryId);
        await deliver(db, seeded.deliveryId, { ...deps, now: clock("01:00:00") });

        expect(sent).toHaveLength(1);
      });

      it("doesn't apply to a webhook", async () => {
        const seeded = await seed({ severity: 4 });
        await settings(seeded.workspaceId, overnight);
        await db.update(destination).set({ type: "webhook" }).where(eq(destination.id, seeded.destinationId));
        const { deps, sent } = recording();

        await deliver(db, seeded.deliveryId, { ...deps, now: clock("23:00:00") });

        expect(sent).toHaveLength(1);
      });
    });

    describe("the rate limit", () => {
      it("holds the 21st alert of an hour until the oldest leaves it, then sends it", async () => {
        const seeded = await seed();
        for (let minute = 10; minute < 30; minute++) await sentEarlier(seeded, at(`11:${String(minute)}:00`));
        const { deps, sent } = recording();

        await deliver(db, seeded.deliveryId, { ...deps, now: clock("12:00:00") });

        expect(sent).toEqual([]);
        expect(await rowOf(seeded.deliveryId)).toMatchObject({ status: "held", nextAttemptAt: at("12:10:00") });
        expect(await actLog(seeded.itemId)).toMatchObject([{ message: "Held until 12:10: rate limit" }]);

        await release(seeded.deliveryId);
        await deliver(db, seeded.deliveryId, { ...deps, now: clock("12:10:00") });

        expect(sent).toHaveLength(1);
        expect(await rowOf(seeded.deliveryId)).toMatchObject({ status: "sent" });
      });

      it("counts a Grouped alert as one", async () => {
        const seeded = await seed();
        const groupId = crypto.randomUUID();
        for (let index = 0; index < 25; index++) await sentEarlier(seeded, at("11:30:00"), { groupId });
        const { deps, sent } = recording();

        await deliver(db, seeded.deliveryId, { ...deps, now: clock("12:00:00") });

        expect(sent).toHaveLength(1);
      });

      it("counts only what went to this Destination, in the last hour, and was sent", async () => {
        const seeded = await seed();
        for (let index = 0; index < 20; index++) await sentEarlier(seeded, at("10:30:00"));
        const elsewhere = await seed();
        for (let index = 0; index < 20; index++) await sentEarlier(elsewhere, at("11:30:00"));
        const failed = await another(seeded);
        await db.update(delivery).set({ status: "failed" }).where(eq(delivery.id, failed.deliveryId));
        const { deps, sent } = recording();

        await deliver(db, seeded.deliveryId, { ...deps, now: clock("12:00:00") });

        expect(sent).toHaveLength(1);
      });
    });

    describe("bursts", () => {
      it("sends 25 alerts due together to one Destination as one message listing 25 Items", async () => {
        const seeded = await seed();
        const others = await Promise.all(Array.from({ length: 24 }, () => another(seeded)));
        const { deps, sent } = recording();

        await deliver(db, seeded.deliveryId, deps);
        // The other 24 jobs, which find their rows already sent.
        for (const { deliveryId } of others) await deliver(db, deliveryId, deps);

        expect(sent).toHaveLength(1);
        expect(present(sent[0]).message).toMatchObject({ count: 25 });
        expect(z.object({ lines: z.array(z.unknown()) }).parse(present(sent[0]).message).lines).toHaveLength(25);
        const rows = await db.select().from(delivery).where(eq(delivery.destinationId, seeded.destinationId));
        expect(rows.map((row) => row.status)).toEqual(Array.from({ length: 25 }, () => "sent"));
        expect(new Set(rows.map((row) => row.groupId)).size).toBe(1);
        expect(present(rows[0]).groupId).not.toBeNull();
        for (const { itemId } of [seeded, ...others]) {
          expect(await actLog(itemId)).toMatchObject([{ message: "Sent to ops-chat in a group of 25" }]);
        }
      });

      it("sends the first alert at once and the 24 that follow in its window as one message", async () => {
        const seeded = await seed();
        const { deps, sent } = recording();
        await deliver(db, seeded.deliveryId, { ...deps, now: clock("12:00:00") });
        expect(sent).toHaveLength(1);
        expect(present(sent[0]).message).toMatchObject({ title: "A security advisory" });

        const followers = [];
        for (let second = 10; second < 34; second++) {
          const follower = await another(seeded);
          await deliver(db, follower.deliveryId, { ...deps, now: clock(`12:00:${String(second)}`) });
          followers.push(follower);
        }

        expect(sent).toHaveLength(1);
        const waiting = await Promise.all(followers.map(({ deliveryId }) => rowOf(deliveryId)));
        expect(waiting.map((row) => row?.status)).toEqual(followers.map(() => "grouped"));
        expect(new Set(waiting.map((row) => row?.nextAttemptAt?.getTime()))).toEqual(
          new Set([at("12:01:00").getTime()]),
        );
        expect(new Set(waiting.map((row) => row?.groupId)).size).toBe(1);
        expect(present(waiting[0]).groupId).not.toBeNull();
        expect(await actLog(present(followers[0]).itemId)).toMatchObject([{ message: "Held until 12:01: burst window" }]);

        for (const { deliveryId } of followers) await release(deliveryId);
        for (const { deliveryId } of followers) await deliver(db, deliveryId, { ...deps, now: clock("12:01:00") });

        expect(sent).toHaveLength(2);
        expect(present(sent[1]).message).toMatchObject({ count: 24 });
        const finished = await rowOf(present(followers[0]).deliveryId);
        expect(finished).toMatchObject({ status: "sent" });
        expect(finished?.groupId).not.toBeNull();
      });

      it("takes a closed window's alerts along when a new alert comes before the sweep does", async () => {
        const seeded = await seed();
        const { deps, sent } = recording();
        await deliver(db, seeded.deliveryId, { ...deps, now: clock("12:00:00") });
        const follower = await another(seeded);
        await deliver(db, follower.deliveryId, { ...deps, now: clock("12:00:10") });
        // The window has closed, and the sweep hasn't run yet.
        await db.update(delivery).set({ nextAttemptAt: new Date(0) }).where(eq(delivery.id, follower.deliveryId));

        const late = await another(seeded);
        await deliver(db, late.deliveryId, { ...deps, now: clock("12:01:10") });

        expect(sent).toHaveLength(2);
        expect(present(sent[1]).message).toMatchObject({ count: 2 });
        expect(await rowOf(follower.deliveryId)).toMatchObject({ status: "sent" });
      });

      it("strands nothing when an old job for a finished Delivery finds others due", async () => {
        const seeded = await seed();
        const { deps, sent } = recording();
        await deliver(db, seeded.deliveryId, { ...deps, now: clock("12:00:00") });
        const follower = await another(seeded);
        await deliver(db, follower.deliveryId, { ...deps, now: clock("12:00:10") });
        await db.update(delivery).set({ nextAttemptAt: new Date(0) }).where(eq(delivery.id, follower.deliveryId));

        await deliver(db, seeded.deliveryId, { ...deps, now: clock("12:01:10") });

        expect(sent).toHaveLength(2);
        expect(await rowOf(follower.deliveryId)).toMatchObject({ status: "sent" });
      });

      it("gives each message its own group id, so the rate limit counts two messages as two", async () => {
        const seeded = await seed();
        const groupId = crypto.randomUUID();
        const message = [seeded, await another(seeded)];
        await db.update(delivery).set({ groupId }).where(eq(delivery.destinationId, seeded.destinationId));
        const { deps, sent } = recording();
        await deliver(db, seeded.deliveryId, { ...deps, now: clock("12:00:00") });

        const later = [await another(seeded), await another(seeded)];
        for (const { deliveryId } of later) await db.update(delivery).set({ groupId }).where(eq(delivery.id, deliveryId));
        await deliver(db, present(later[0]).deliveryId, { ...deps, now: clock("12:05:00") });

        expect(sent).toHaveLength(2);
        const ids = await Promise.all([...message, ...later].map(({ deliveryId }) => rowOf(deliveryId)));
        expect(ids.map((row) => row?.status)).toEqual(["sent", "sent", "sent", "sent"]);
        expect(present(ids[0]).groupId).toBe(present(ids[1]).groupId);
        expect(present(ids[2]).groupId).toBe(present(ids[3]).groupId);
        expect(present(ids[0]).groupId).not.toBe(present(ids[2]).groupId);
      });

      it("lets sends to one webhook run at the same time", async () => {
        const seeded = await seed();
        const other = await another(seeded);
        await db.update(destination).set({ type: "webhook" }).where(eq(destination.id, seeded.destinationId));
        let started = 0;
        const both = Promise.withResolvers<undefined>();
        const { deps } = recording(async () => {
          started += 1;
          if (started === 2) both.resolve(undefined);
          await both.promise;
        });

        await Promise.all([deliver(db, seeded.deliveryId, deps), deliver(db, other.deliveryId, deps)]);

        expect(started).toBe(2);
      });

      it("sends a window's only follower as an ordinary alert", async () => {
        const seeded = await seed();
        const { deps, sent } = recording();
        await deliver(db, seeded.deliveryId, { ...deps, now: clock("12:00:00") });
        const follower = await another(seeded);
        await deliver(db, follower.deliveryId, { ...deps, now: clock("12:00:10") });

        await release(follower.deliveryId);
        await deliver(db, follower.deliveryId, { ...deps, now: clock("12:01:00") });

        expect(present(sent[1]).message).toMatchObject({ title: "Another advisory", why: "Severity is at least 4" });
        expect(await actLog(follower.itemId)).toMatchObject([
          { message: "Held until 12:01: burst window" },
          { message: "Sent to ops-chat" },
        ]);
      });

      it("lists a group as Top would order it, with unrated Items last", async () => {
        const seeded = await seed({ title: "Middle", severity: 3, importance: 3 });
        await another(seeded, { title: "Unrated", severity: null, importance: null });
        await another(seeded, { title: "Highest", severity: 5, importance: 5 });
        const { deps, sent } = recording();

        await deliver(db, seeded.deliveryId, deps);

        const { lines } = z
          .object({ lines: z.array(z.object({ title: z.string() })) })
          .parse(present(sent[0]).message);
        expect(lines.map((line) => line.title)).toEqual(["Highest", "Middle", "Unrated"]);
      });

      it("never groups a webhook's Deliveries", async () => {
        const seeded = await seed();
        const other = await another(seeded);
        await db.update(destination).set({ type: "webhook" }).where(eq(destination.id, seeded.destinationId));
        const { deps, sent } = recording();

        await deliver(db, seeded.deliveryId, deps);
        await deliver(db, other.deliveryId, deps);

        expect(sent).toHaveLength(2);
        expect(present(sent[0]).message).toHaveProperty("firedBecause", "Severity is at least 4");
      });

      it("retries a failed group's rows together, and sends them as one message", async () => {
        const seeded = await seed();
        const other = await another(seeded);
        let failures = 1;
        const { deps, sent, retries } = recording(() =>
          failures-- > 0 ? Promise.reject(new Error("Down")) : Promise.resolve(),
        );
        const failedAt = new Date();

        await deliver(db, seeded.deliveryId, { ...deps, now: () => failedAt });

        const retryAt = new Date(failedAt.getTime() + 30_000);
        expect(retries).toEqual(
          expect.arrayContaining([
            { deliveryId: seeded.deliveryId, at: retryAt },
            { deliveryId: other.deliveryId, at: retryAt },
          ]),
        );
        for (const { deliveryId, itemId } of [seeded, other]) {
          expect(await rowOf(deliveryId)).toMatchObject({ status: "queued", attempts: 1, nextAttemptAt: retryAt });
          expect(await actLog(itemId)).toMatchObject([
            { message: `Sending to ops-chat failed: Down, retrying at ${retryAt.toISOString()}` },
          ]);
        }

        await db.update(delivery).set({ nextAttemptAt: failedAt }).where(eq(delivery.destinationId, seeded.destinationId));
        await deliver(db, other.deliveryId, deps);

        expect(sent).toHaveLength(2);
        expect(present(sent[1]).message).toMatchObject({ count: 2 });
        expect(await rowOf(seeded.deliveryId)).toMatchObject({ status: "sent", attempts: 2 });
      });

      it("fails only the row of a group that is past its 24 hours", async () => {
        const seeded = await seed();
        const other = await another(seeded);
        const now = new Date();
        await db
          .update(delivery)
          .set({ createdAt: new Date(now.getTime() - 24 * hour) })
          .where(eq(delivery.id, seeded.deliveryId));
        const { deps } = recording(() => Promise.reject(new Error("Down")));

        await deliver(db, other.deliveryId, { ...deps, now: () => now });

        expect(await rowOf(seeded.deliveryId)).toMatchObject({ status: "failed" });
        expect(await rowOf(other.deliveryId)).toMatchObject({ status: "queued", attempts: 1 });
      });

      it("never repeats an Item when jobs for one Destination run at the same time", async () => {
        const seeded = await seed();
        const others = await Promise.all(Array.from({ length: 5 }, () => another(seeded)));
        const { deps, sent } = recording(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
        });

        await Promise.all([seeded, ...others].map(({ deliveryId }) => deliver(db, deliveryId, deps)));

        expect(sent).toHaveLength(1);
        expect(present(sent[0]).message).toMatchObject({ count: 6 });
      });

      it("lets a new Delivery be inserted for a Destination during a send to it", async () => {
        const seeded = await seed();
        const { deps } = recording(async () => {
          await another(seeded);
        });

        await deliver(db, seeded.deliveryId, deps);

        expect(await rowOf(seeded.deliveryId)).toMatchObject({ status: "sent" });
      });
    });
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
