import type { AlertSender } from "@watchdog/core";
import {
  action,
  actionDestination,
  closeDb,
  createDb,
  type Db,
  delivery,
  destination,
  digestItem,
  eq,
  item,
  itemLog,
  migrate,
  source,
  sourceAlert,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres, type TestPostgres } from "@watchdog/db/testing";
import { PgBoss } from "pg-boss";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDeliveryQueue,
  capNoticeQueuer,
  createCapNoticeQueue,
  deliverQueue,
  deliveryEnqueuer,
  digestQueue,
  enqueueDueDeliveries,
  enqueueDueDigests,
  startDelivery,
} from "./delivery.ts";

/** The value, which the test expects to be there. */
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}

const waitLong = { timeout: 30_000, interval: 100 };

describe("the deliver queue", () => {
  let postgres: TestPostgres;
  let db: Db;
  /** Only queues and expires jobs. Each test starts its own worker, so it picks the sender. */
  let boss: PgBoss;
  let worker: PgBoss | undefined;

  beforeAll(async () => {
    postgres = await startPostgres();
    await migrate(postgres.url);
    db = createDb(postgres.url);
    boss = new PgBoss({ connectionString: postgres.url, schedule: false, supervise: false });
    await boss.start();
    await createDeliveryQueue(boss);
    return async () => {
      await boss.stop();
      await closeDb(db);
      await postgres.stop();
    };
  }, 120_000);

  afterEach(async () => {
    await worker?.stop({ timeout: 1_000 });
    worker = undefined;
    // A job a test left waiting would go to the next test's sender.
    await db.$client.query("delete from pgboss.job where name = $1", [deliverQueue]);
  });

  /** A queued Delivery with no job yet. */
  async function seed() {
    const ownerId = crypto.randomUUID();
    await db.insert(user).values({ id: ownerId, name: "Owner", email: `${ownerId}@example.com` });
    const [ws] = await db.insert(workspace).values({ name: "Workspace", ownerUserId: ownerId }).returning();
    const workspaceId = present(ws).id;
    const [src] = await db
      .insert(source)
      .values({
        workspaceId,
        type: "rss",
        name: "Feed",
        config: { url: "https://feeds.test/feed.rss" },
        schedule: "*/15 * * * *",
      })
      .returning();
    const [captured] = await db
      .insert(item)
      .values({ workspaceId, sourceId: present(src).id, externalId: "one", title: "One", body: "An entry.", raw: {} })
      .returning();
    const itemId = present(captured).id;
    const [chat] = await db
      .insert(destination)
      .values({ workspaceId, type: "telegram", name: "ops-chat", confirmedAt: new Date() })
      .returning();
    const destinationId = present(chat).id;
    const [saved] = await db
      .insert(action)
      .values({
        workspaceId,
        name: "ones",
        kind: "alert",
        definition: {
          action: "ones",
          when: { field: "title", op: "is", value: "One" },
          kind: "alert",
          destinations: [destinationId],
        },
      })
      .returning();
    const actionId = present(saved).id;
    await db.insert(actionDestination).values({ actionId, destinationId });
    const [row] = await db.insert(delivery).values({ actionId, itemId, destinationId }).returning();
    return { itemId, deliveryId: present(row).id };
  }

  const enqueue = (deliveryId: string) =>
    db.transaction((tx) => deliveryEnqueuer(boss)(tx, [deliveryId]));

  async function startWorker(send: AlertSender["send"]) {
    worker = new PgBoss({ connectionString: postgres.url, schedule: false, supervise: false });
    await worker.start();
    const sender = { send };
    await startDelivery(db, worker, {
      senders: {
        telegram: sender,
        email: sender,
        webhook: { send: () => Promise.reject(new Error("These tests send no webhooks")) },
      },
      appUrl: "https://watchdog.test",
      secret: "a-better-auth-secret-of-at-least-32-chars",
    });
    return worker;
  }

  const rowOf = async (deliveryId: string) => db.query.delivery.findFirst({ where: eq(delivery.id, deliveryId) });
  const logOf = async (itemId: string) =>
    (await db.select().from(itemLog).where(eq(itemLog.itemId, itemId)).orderBy(itemLog.id)).map((row) => row.message);
  const jobsOf = async (deliveryId: string) =>
    (
      await db.$client.query<{ state: string; start_after: Date; keep_until: Date }>(
        "select state, start_after, keep_until from pgboss.job where name = $1 and data->>'deliveryId' = $2",
        [deliverQueue, deliveryId],
      )
    ).rows;

  it("keeps the queue's retries and expiry on an upgraded install too", async () => {
    await boss.updateQueue(deliverQueue, { expireInSeconds: 60, retryLimit: 1 });

    await createDeliveryQueue(boss);

    expect(await boss.getQueue(deliverQueue)).toMatchObject({
      expireInSeconds: 900,
      retryLimit: 12,
      retryBackoff: true,
    });
  });

  it("queues no job when the transaction that inserts the Delivery rolls back", async () => {
    const { deliveryId } = await seed();

    await expect(
      db.transaction(async (tx) => {
        await deliveryEnqueuer(boss)(tx, [deliveryId]);
        throw new Error("The Act stage failed after queueing");
      }),
    ).rejects.toThrow("The Act stage failed after queueing");

    expect(await jobsOf(deliveryId)).toEqual([]);
  });

  it("holds a waiting job for 24 hours past its start at the very least", async () => {
    const { deliveryId } = await seed();
    await enqueue(deliveryId);

    const [job] = await jobsOf(deliveryId);
    const { keep_until: keepUntil, start_after: startAfter } = present(job);
    expect(keepUntil.getTime() - startAfter.getTime()).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
  });

  it("sends a queued Delivery in its job", async () => {
    const { deliveryId, itemId } = await seed();
    const send = vi.fn<AlertSender["send"]>(() => Promise.resolve());
    await startWorker(send);

    await enqueue(deliveryId);

    await vi.waitFor(async () => {
      expect(await rowOf(deliveryId)).toMatchObject({ status: "sent", attempts: 1 });
    }, waitLong);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await logOf(itemId)).toEqual(["Sent to ops-chat"]);
  });

  it("retries through new jobs at the times the Log names, and sends once on the third attempt", async () => {
    const { deliveryId, itemId } = await seed();
    let failures = 2;
    const send = vi.fn<AlertSender["send"]>(() =>
      failures-- > 0 ? Promise.reject(new Error("Chat unreachable")) : Promise.resolve(),
    );
    await startWorker(send);
    await enqueue(deliveryId);

    for (const attempts of [1, 2]) {
      const row = await vi.waitFor(async () => {
        const found = await rowOf(deliveryId);
        expect(found).toMatchObject({ status: "queued", attempts });
        return present(found);
      }, waitLong);
      // The attempt's job is finished, and the next waits for the time the row and the Log say.
      const waiting = await vi.waitFor(async () => {
        const jobs = await jobsOf(deliveryId);
        expect(jobs.filter((job) => job.state === "active")).toEqual([]);
        return jobs.filter((job) => job.state === "created");
      }, waitLong);
      expect(waiting.map((job) => job.start_after)).toEqual([row.nextAttemptAt]);
      // Stands in for waiting out the delay.
      await db.$client.query("update delivery set next_attempt_at = now() where id = $1", [deliveryId]);
      await db.$client.query(
        "update pgboss.job set start_after = now() where name = $1 and state = 'created' and data->>'deliveryId' = $2",
        [deliverQueue, deliveryId],
      );
    }

    await vi.waitFor(async () => {
      expect(await rowOf(deliveryId)).toMatchObject({ status: "sent", attempts: 3 });
    }, waitLong);
    expect(send).toHaveBeenCalledTimes(3);
    expect(await logOf(itemId)).toEqual([
      expect.stringContaining("Sending to ops-chat failed: Chat unreachable, retrying at"),
      expect.stringContaining("Sending to ops-chat failed: Chat unreachable, retrying at"),
      "Sent to ops-chat",
    ]);

    // A stray job for it changes nothing.
    await enqueue(deliveryId);
    await vi.waitFor(async () => {
      expect((await jobsOf(deliveryId)).filter((job) => job.state !== "completed")).toEqual([]);
    }, waitLong);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("lets a running send finish when the worker stops", async () => {
    const { deliveryId, itemId } = await seed();
    const held = Promise.withResolvers<undefined>();
    let started = false;
    const running = await startWorker(async () => {
      started = true;
      await held.promise;
    });
    await enqueue(deliveryId);
    await vi.waitFor(() => {
      expect(started).toBe(true);
    }, waitLong);

    const stopped = running.stop();
    held.resolve(undefined);
    await stopped;
    worker = undefined;

    expect(await rowOf(deliveryId)).toMatchObject({ status: "sent", attempts: 1 });
    expect(await logOf(itemId)).toEqual(["Sent to ops-chat"]);
  });

  it("runs a job again after its worker died during the send, and the Delivery still goes", async () => {
    const { deliveryId, itemId } = await seed();
    await enqueue(deliveryId);
    // A worker that claims the job and is never heard from again.
    expect(await boss.fetch(deliverQueue)).toHaveLength(1);
    expect((await jobsOf(deliveryId)).map((job) => job.state)).toEqual(["active"]);

    // Stands in for waiting out the expiry and the retry's delay.
    await db.$client.query(
      `update pgboss.job set started_on = now() - interval '1 hour', retry_delay = 0, retry_backoff = false
       where name = $1 and data->>'deliveryId' = $2`,
      [deliverQueue, deliveryId],
    );
    await boss.supervise(deliverQueue);
    expect((await jobsOf(deliveryId)).map((job) => job.state)).toEqual(["retry"]);

    const send = vi.fn<AlertSender["send"]>(() => Promise.resolve());
    await startWorker(send);

    await vi.waitFor(async () => {
      expect(await rowOf(deliveryId)).toMatchObject({ status: "sent", attempts: 1 });
    }, waitLong);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await logOf(itemId)).toEqual(["Sent to ops-chat"]);
  });

  describe("the hosted email cap's notice", () => {
    const jobs = async () =>
      (await db.$client.query<{ id: string }>("select id from pgboss.job where name = 'email-cap-notice'")).rows;

    it("goes out in a job of its own", async () => {
      worker = new PgBoss({ connectionString: postgres.url, schedule: false, supervise: false });
      await worker.start();
      const sender = { send: () => Promise.resolve() };
      const sendCapNotice = vi.fn<(workspaceId: string) => Promise<void>>(() => Promise.resolve());
      await startDelivery(db, worker, {
        senders: { telegram: sender, email: sender, webhook: sender },
        appUrl: "https://watchdog.test",
        secret: "a-better-auth-secret-of-at-least-32-chars",
        sendCapNotice,
      });
      const workspaceId = crypto.randomUUID();

      await db.transaction((tx) => capNoticeQueuer(boss).queueNotice(tx, workspaceId));

      await vi.waitFor(() => {
        expect(sendCapNotice).toHaveBeenCalledWith(workspaceId);
      }, waitLong);
    });

    it("isn't queued when the transaction that holds the mail rolls back", async () => {
      await createCapNoticeQueue(boss);
      const before = (await jobs()).length;

      await expect(
        db.transaction(async (tx) => {
          await capNoticeQueuer(boss).queueNotice(tx, crypto.randomUUID());
          throw new Error("The hold failed");
        }),
      ).rejects.toThrow("The hold failed");

      expect(await jobs()).toHaveLength(before);
    });
  });

  describe("Digests", () => {
    /** The seeded Item collected into a Digest that was saved two days ago, so its daily schedule has come. */
    async function seedDigest() {
      const { itemId, deliveryId } = await seed();
      const { actionId, destinationId } = present(await rowOf(deliveryId));
      await db.delete(delivery).where(eq(delivery.id, deliveryId));
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      await db
        .update(action)
        .set({
          name: "Daily",
          kind: "digest",
          definition: { action: "Daily", when: { field: "title", op: "is", value: "One" }, kind: "digest", schedule: "0 0 * * *", destinations: [destinationId] },
          updatedAt: twoDaysAgo,
        })
        .where(eq(action.id, actionId));
      await db.insert(digestItem).values({ actionId, itemId });
      return { itemId, actionId };
    }
    const digestJobs = async (actionId: string) =>
      (await db.$client.query<{ id: string }>("select id from pgboss.job where name = $1 and singleton_key = $2", [digestQueue, actionId]))
        .rows;

    it("queues one job for a due Digest however many sweeps run, and its job sends it once", async () => {
      const { itemId, actionId } = await seedDigest();
      const send = vi.fn<AlertSender["send"]>(() => Promise.resolve());
      await startWorker(send);

      await enqueueDueDigests(db, boss);
      await enqueueDueDigests(db, boss);

      await vi.waitFor(async () => {
        expect(await logOf(itemId)).toEqual(["Sent in the Digest Daily to ops-chat"]);
      }, waitLong);
      expect(send).toHaveBeenCalledTimes(1);
      expect(await digestJobs(actionId)).toHaveLength(1);
    });
  });

  describe("waiting Deliveries", () => {
    /** Another queued alert to the seeded Delivery's Destination, about a new Item. */
    async function another(deliveryId: string, externalId: string) {
      const first = present(await rowOf(deliveryId));
      const firstItem = present(await db.query.item.findFirst({ where: eq(item.id, first.itemId) }));
      const [captured] = await db
        .insert(item)
        .values({
          workspaceId: firstItem.workspaceId,
          sourceId: firstItem.sourceId,
          externalId,
          title: externalId,
          body: "An entry.",
          raw: {},
        })
        .returning();
      const [row] = await db
        .insert(delivery)
        .values({ actionId: first.actionId, itemId: present(captured).id, destinationId: first.destinationId })
        .returning();
      return present(row).id;
    }

    const wait = (deliveryId: string, status: "held" | "grouped", nextAttemptAt: Date) =>
      db.update(delivery).set({ status, nextAttemptAt }).where(eq(delivery.id, deliveryId));

    it("sends a held Delivery whose time passed while no worker ran, once one starts", async () => {
      const { deliveryId, itemId } = await seed();
      await wait(deliveryId, "held", new Date(Date.now() - 60_000));
      const send = vi.fn<AlertSender["send"]>(() => Promise.resolve());

      await startWorker(send);

      await vi.waitFor(async () => {
        expect(await rowOf(deliveryId)).toMatchObject({ status: "sent", attempts: 1 });
      }, waitLong);
      expect(send).toHaveBeenCalledTimes(1);
      expect(await logOf(itemId)).toEqual(["Sent to ops-chat"]);
    });

    it("leaves a Delivery alone until its time comes", async () => {
      const { deliveryId } = await seed();
      const until = new Date(Date.now() + 60 * 60 * 1000);
      await wait(deliveryId, "held", until);

      await enqueueDueDeliveries(db, boss);

      expect(await rowOf(deliveryId)).toMatchObject({ status: "held", nextAttemptAt: until });
      expect(await jobsOf(deliveryId)).toEqual([]);
    });

    it("queues one job for a due Delivery however many sweeps run", async () => {
      const { deliveryId } = await seed();
      await wait(deliveryId, "held", new Date(Date.now() - 60_000));

      await enqueueDueDeliveries(db, boss);
      await enqueueDueDeliveries(db, boss);

      expect(await jobsOf(deliveryId)).toHaveLength(1);
      expect(await rowOf(deliveryId)).toMatchObject({ status: "queued", nextAttemptAt: null });
    });

    it("passes over a row another transaction holds, rather than wait for it", async () => {
      const { deliveryId } = await seed();
      const other = await another(deliveryId, "two");
      const past = new Date(Date.now() - 60_000);
      await wait(deliveryId, "held", past);
      await wait(other, "held", past);
      const holding = Promise.withResolvers<undefined>();
      const swept = Promise.withResolvers<undefined>();

      const holder = db.transaction(async (tx) => {
        await tx.select({ id: delivery.id }).from(delivery).where(eq(delivery.id, deliveryId)).for("update");
        holding.resolve(undefined);
        await swept.promise;
      });
      await holding.promise;
      await enqueueDueDeliveries(db, boss);
      swept.resolve(undefined);
      await holder;

      expect(await rowOf(deliveryId)).toMatchObject({ status: "held" });
      expect(await rowOf(other)).toMatchObject({ status: "queued" });

      await enqueueDueDeliveries(db, boss);
      expect(await rowOf(deliveryId)).toMatchObject({ status: "queued" });
    });

    it("sends the grouped Deliveries of a closed window as one message", async () => {
      const { deliveryId } = await seed();
      const others = [await another(deliveryId, "two"), await another(deliveryId, "three")];
      const groupId = crypto.randomUUID();
      const closed = new Date(Date.now() - 1000);
      for (const id of [deliveryId, ...others]) {
        await wait(id, "grouped", closed);
        await db.update(delivery).set({ groupId }).where(eq(delivery.id, id));
      }
      const send = vi.fn<AlertSender["send"]>(() => Promise.resolve());

      await startWorker(send);

      await vi.waitFor(async () => {
        expect(await rowOf(deliveryId)).toMatchObject({ status: "sent" });
      }, waitLong);
      // The other jobs have to finish too, to show that they send nothing.
      await vi.waitFor(async () => {
        const jobs = (await Promise.all([deliveryId, ...others].map(jobsOf))).flat();
        expect(jobs.map((job) => job.state)).toEqual(["completed", "completed", "completed"]);
      }, waitLong);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[1]).toMatchObject({ count: 3 });
    });

    it("sends 25 alerts queued in one minute to one Destination as one message", async () => {
      const { deliveryId } = await seed();
      const others = await Promise.all(
        Array.from({ length: 24 }, (_, index) => another(deliveryId, `item-${String(index)}`)),
      );
      const ids = [deliveryId, ...others];
      await db.transaction((tx) => deliveryEnqueuer(boss)(tx, ids));
      const send = vi.fn<AlertSender["send"]>(() => Promise.resolve());

      await startWorker(send);

      await vi.waitFor(async () => {
        const jobs = (await Promise.all(ids.map(jobsOf))).flat();
        expect(jobs.filter((job) => job.state !== "completed")).toEqual([]);
      }, waitLong);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[1]).toMatchObject({ count: 25 });
    });

    it("sends 25 alerts queued in one minute as 25 messages when the burst window is 0", async () => {
      const { deliveryId } = await seed();
      const { destinationId } = present(await rowOf(deliveryId));
      const target = present(await db.query.destination.findFirst({ where: eq(destination.id, destinationId) }));
      await db
        .update(workspace)
        .set({ burstWindowSeconds: 0, alertsPerHour: 25 })
        .where(eq(workspace.id, target.workspaceId));
      const others = await Promise.all(
        Array.from({ length: 24 }, (_, index) => another(deliveryId, `item-${String(index)}`)),
      );
      const ids = [deliveryId, ...others];
      await db.transaction((tx) => deliveryEnqueuer(boss)(tx, ids));
      const send = vi.fn<AlertSender["send"]>(() => Promise.resolve());

      await startWorker(send);

      await vi.waitFor(async () => {
        const jobs = (await Promise.all(ids.map(jobsOf))).flat();
        expect(jobs.filter((job) => job.state !== "completed")).toEqual([]);
      }, waitLong);
      expect(send).toHaveBeenCalledTimes(25);
      for (const [, message] of send.mock.calls) expect(message).toHaveProperty("why");
      const rows = await Promise.all(ids.map(rowOf));
      expect(rows.map((row) => row?.status)).toEqual(ids.map(() => "sent"));
    });
  });

  it("sends a new Source Health alert from the sweep, once", async () => {
    const ownerId = crypto.randomUUID();
    await db.insert(user).values({ id: ownerId, name: "Owner", email: `${ownerId}@example.com` });
    const [ws] = await db.insert(workspace).values({ name: "Workspace", ownerUserId: ownerId }).returning();
    const workspaceId = present(ws).id;
    const [src] = await db
      .insert(source)
      .values({ workspaceId, type: "rss", name: "Feed", config: { url: "https://feeds.test/feed.rss" }, schedule: "*/15 * * * *" })
      .returning();
    // As a failed poll writes it: held and due, with no job.
    const [alert] = await db
      .insert(sourceAlert)
      .values({ workspaceId, sourceId: present(src).id, kind: "failing", error: "The feed answered 500" })
      .returning();
    const send = vi.fn<AlertSender["send"]>(() => Promise.resolve());

    // The sweep runs once when the worker starts.
    await startWorker(send);

    await vi.waitFor(async () => {
      const [row] = await db.select().from(sourceAlert).where(eq(sourceAlert.id, present(alert).id));
      expect(row).toMatchObject({ status: "sent", attempts: 1 });
    }, waitLong);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ type: "email", config: { address: `${ownerId}@example.com` } });
    expect(send.mock.calls[0]?.[1]).toEqual({
      health: "failing",
      source: "Feed",
      error: "The feed answered 500",
      link: "https://watchdog.test/sources",
    });
  });

  it("ends the job quietly when the Delivery is gone", async () => {
    const { deliveryId, itemId } = await seed();
    await db.delete(item).where(eq(item.id, itemId));
    const send = vi.fn<AlertSender["send"]>(() => Promise.resolve());
    await startWorker(send);

    await enqueue(deliveryId);

    await vi.waitFor(async () => {
      expect((await jobsOf(deliveryId)).map((job) => job.state)).toEqual(["completed"]);
    }, waitLong);
    expect(send).not.toHaveBeenCalled();
  });
});
