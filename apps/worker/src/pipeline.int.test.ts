import { agentItemQueue, itemEnqueuer, pollSource, processItemQueue } from "@watchdog/core";
import { fakeLlm } from "@watchdog/core/testing";
import {
  action,
  actionDestination,
  agentCall,
  classifier,
  closeDb,
  createDb,
  type Db,
  delivery,
  destination,
  eq,
  inArray,
  item,
  itemCategory,
  itemLog,
  migrate,
  modelConfig,
  source,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres, type TestPostgres } from "@watchdog/db/testing";
import { PgBoss } from "pg-boss";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createDeliveryQueue, deliverQueue } from "./delivery.ts";
import { createPipelineQueue, startPipeline } from "./pipeline.ts";

/** The value, which the test expects to be there. */
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}

// No live HTTP: every feed has these entries, dated now so they all fall in the Backfill window.
const feed = (ids: string[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>Synthetic</title>` +
  ids
    .map(
      (id) =>
        `<item><guid>${id}</guid><title>Launch of ${id}</title>` +
        `<description>An entry.</description><pubDate>${new Date().toUTCString()}</pubDate></item>`,
    )
    .join("") +
  `</channel></rss>`;

describe("pipeline", () => {
  let postgres: TestPostgres;
  let db: Db;
  let boss: PgBoss;
  let workspaceId: string;
  /** Stands in for the egress guard's fetch, which reaches the model. */
  let modelFetch: ReturnType<typeof fakeLlm>["fetch"];

  beforeAll(async () => {
    postgres = await startPostgres();
    await migrate(postgres.url);
    db = createDb(postgres.url);
    await db.insert(user).values({ id: "owner", name: "Owner", email: "owner@example.com" });
    const [ws] = await db
      .insert(workspace)
      .values({ name: "Workspace", ownerUserId: "owner" })
      .returning();
    workspaceId = present(ws).id;
    boss = new PgBoss(postgres.url);
    await boss.start();
    // No worker takes these jobs here, so a test can look at them.
    await createDeliveryQueue(boss);
    await startPipeline(db, boss, {
      fetch: (input, init) => modelFetch(input, init),
      encryptionKey: Buffer.alloc(32, 7),
    });
    return async () => {
      await boss.stop();
      await closeDb(db);
      await postgres.stop();
    };
  }, 120_000);

  async function newSource() {
    const [created] = await db
      .insert(source)
      .values({
        workspaceId,
        type: "rss",
        name: "Feed",
        config: { url: `https://feeds.test/${crypto.randomUUID()}.rss` },
        schedule: "*/15 * * * *",
      })
      .returning();
    return present(created).id;
  }

  const answering = (ids: string[]) => ({
    fetch: () => Promise.resolve(new Response(feed(ids))),
    enqueueItems: itemEnqueuer(boss),
    secrets: { encryptionKey: Buffer.alloc(32), authSecret: "unused-by-rss-sources" },
  });

  const itemIdsOf = async (sourceId: string) =>
    (await db.select({ id: item.id }).from(item).where(eq(item.sourceId, sourceId))).map((row) => row.id);

  /** The Item id in each job on either queue, for these Items. */
  const jobsFor = async (itemIds: string[]) =>
    (
      await db.$client.query<{ itemId: string }>(
        `select data->>'itemId' as "itemId" from pgboss.job
         where name = any($1) and data->>'itemId' = any($2)`,
        [[processItemQueue, agentItemQueue], itemIds],
      )
    ).rows.map((row) => row.itemId);

  it("queues exactly one job per new Item, Backfill included, and none for known entries", async () => {
    const sourceId = await newSource();

    await pollSource(db, sourceId, answering(["one", "two"]));
    const backfilled = await itemIdsOf(sourceId);
    expect(backfilled).toHaveLength(2);
    expect((await jobsFor(backfilled)).sort()).toEqual([...backfilled].sort());

    // Polled again with one more entry: only the new Item gets a job.
    await pollSource(db, sourceId, answering(["one", "two", "three"]));
    const all = await itemIdsOf(sourceId);
    expect(all).toHaveLength(3);
    expect((await jobsFor(all)).sort()).toEqual([...all].sort());
  });

  it("keeps a waiting job through a long outage, beyond pg-boss's default 14 days", async () => {
    const sourceId = await newSource();
    await pollSource(db, sourceId, answering(["one"]));
    const itemId = present((await itemIdsOf(sourceId))[0]);

    const { rows } = await db.$client.query<{ days: number }>(
      `select (extract(epoch from keep_until - created_on) / 86400)::float8 as days
       from pgboss.job where name = $1 and data->>'itemId' = $2`,
      [processItemQueue, itemId],
    );
    expect(rows[0]?.days).toBeGreaterThanOrEqual(89);
  });

  it("queues no job and keeps no Item when the capture rolls back", async () => {
    const sourceId = await newSource();
    const enqueueItems = itemEnqueuer(boss);
    const queued: string[] = [];

    await expect(
      pollSource(db, sourceId, {
        ...answering(["one"]),
        // The job is written, then the transaction it's in fails.
        enqueueItems: async (tx, itemIds) => {
          await enqueueItems(tx, itemIds);
          queued.push(...itemIds);
          throw new Error("The capture failed after queueing");
        },
      }),
    ).rejects.toThrow("The capture failed after queueing");

    expect(queued).toHaveLength(1);
    expect(await jobsFor(queued)).toEqual([]);
    expect(await itemIdsOf(sourceId)).toEqual([]);
  });

  it("runs the Act stage in the job, for an Item that isn't from the Backfill", async () => {
    const [mail] = await db
      .insert(destination)
      .values({ workspaceId, type: "email", name: "act-stage", confirmedAt: new Date() })
      .returning();
    const destinationId = present(mail).id;
    const when = { field: "title", op: "contains", value: "act-stage" };
    const definition = { action: "act-stage", when, kind: "alert", destinations: [destinationId] };
    const [saved] = await db
      .insert(action)
      .values({ workspaceId, name: "act-stage", kind: "alert", definition })
      .returning();
    const actionId = present(saved).id;
    await db.insert(actionDestination).values({ actionId, destinationId });
    const sourceId = await newSource();
    await pollSource(db, sourceId, answering(["old-act-stage"]));
    await pollSource(db, sourceId, answering(["old-act-stage", "new-act-stage"]));
    const fired = await db.query.item.findFirst({ where: eq(item.externalId, "new-act-stage") });
    const itemId = present(fired).id;

    const deliveries = await vi.waitFor(
      async () => {
        const rows = await db.select().from(delivery).where(eq(delivery.actionId, actionId));
        expect(rows).toHaveLength(1);
        return rows;
      },
      { timeout: 15_000 },
    );

    expect(deliveries).toMatchObject([{ itemId, destinationId, status: "queued" }]);
    const { rows } = await db.$client.query<{ deliveryId: string }>(
      "select data->>'deliveryId' as \"deliveryId\" from pgboss.job where name = $1",
      [deliverQueue],
    );
    expect(rows).toEqual([{ deliveryId: present(deliveries[0]).id }]);
  });

  it("classifies a captured Item in its job", async () => {
    const definition = {
      classifier: "launches",
      when: { field: "title", op: "contains", value: "launch" },
      assign: ["launch"],
    };
    await db
      .insert(classifier)
      .values({ workspaceId, name: "launches", kind: "deterministic", definition });
    const sourceId = await newSource();

    await pollSource(db, sourceId, answering(["one"]));
    const itemId = present((await itemIdsOf(sourceId))[0]);

    const processed = await vi.waitFor(
      async () => {
        const found = await db.query.item.findFirst({ where: eq(item.id, itemId) });
        expect(found?.processedAt).not.toBeNull();
        return found;
      },
      { timeout: 15_000 },
    );
    expect(processed?.isBackfill).toBe(true);
    expect(await db.select().from(itemCategory).where(eq(itemCategory.itemId, itemId))).toMatchObject(
      [{ category: "launch" }],
    );
  });

  describe("with a model", () => {
    /** A Workspace of its own, so the other tests' Items stay out of the model's way. */
    async function modelWorkspace(baseUrl = "https://llm.test/v1") {
      const id = crypto.randomUUID();
      await db.insert(user).values({ id, name: "Owner", email: `${id}@example.com` });
      const [ws] = await db.insert(workspace).values({ name: "Models", ownerUserId: id }).returning();
      const ownId = present(ws).id;
      await db.insert(modelConfig).values({
        workspaceId: ownId,
        providerType: "openai-compatible",
        baseUrl,
        modelName: "fake-model",
      });
      await db.insert(classifier).values({
        workspaceId: ownId,
        name: "leads",
        kind: "agent",
        definition: { classifier: "leads", prompt: "Find leads", categories: ["lead"] },
      });
      const [created] = await db
        .insert(source)
        .values({
          workspaceId: ownId,
          type: "rss",
          name: "Feed",
          config: { url: `https://feeds.test/${crypto.randomUUID()}.rss` },
          schedule: "*/15 * * * *",
        })
        .returning();
      return { workspaceId: ownId, sourceId: present(created).id };
    }

    /** A Workspace with no model, so nothing its Items do can reach the Agent. */
    async function plainWorkspace() {
      const id = crypto.randomUUID();
      await db.insert(user).values({ id, name: "Owner", email: `${id}@example.com` });
      const [ws] = await db.insert(workspace).values({ name: "Plain", ownerUserId: id }).returning();
      const ownId = present(ws).id;
      await db.insert(classifier).values({
        workspaceId: ownId,
        name: "launches",
        kind: "deterministic",
        definition: {
          classifier: "launches",
          when: { field: "title", op: "contains", value: "launch" },
          assign: ["plain"],
        },
      });
      const [created] = await db
        .insert(source)
        .values({
          workspaceId: ownId,
          type: "rss",
          name: "Feed",
          config: { url: `https://feeds.test/${crypto.randomUUID()}.rss` },
          schedule: "*/15 * * * *",
        })
        .returning();
      return { workspaceId: ownId, sourceId: present(created).id };
    }

    /**
     * A model whose calls to the hosts `holding` picks wait until the test releases them, counting what
     * runs at once: per host, and in total. The rest answer at once.
     */
    function holdingModel(fake: ReturnType<typeof fakeLlm>, holding: (host: string) => boolean) {
      const held: (() => void)[] = [];
      const running = new Map<string, number>();
      const most = new Map<string, number>();
      let total = 0;
      let mostTotal = 0;
      const hostOf = (input: unknown) => new URL(String(input)).host;
      const fetch: ReturnType<typeof fakeLlm>["fetch"] = async (input, init) => {
        if (!holding(hostOf(input))) return fake.fetch(input, init);
        const host = hostOf(input);
        total += 1;
        mostTotal = Math.max(mostTotal, total);
        const here = (running.get(host) ?? 0) + 1;
        running.set(host, here);
        most.set(host, Math.max(most.get(host) ?? 0, here));
        await new Promise<void>((resolve) => {
          held.push(() => {
            total -= 1;
            running.set(host, (running.get(host) ?? 1) - 1);
            resolve();
          });
        });
        return fake.fetch(input, init);
      };
      return {
        fetch,
        total: () => total,
        mostTotal: () => mostTotal,
        mostIn: (host: string) => most.get(host) ?? 0,
        /**
         * Releases what waits, until every Item of these Sources is finished: a job left running would
         * reach the next test's model.
         */
        async settle(sourceIds: string[]) {
          await vi.waitFor(
            async () => {
              for (const release of held.splice(0)) release();
              const rows = await db.select().from(item).where(inArray(item.sourceId, sourceIds));
              expect(rows.filter((row) => row.processedAt === null)).toHaveLength(0);
            },
            { timeout: 60_000 },
          );
        },
        release: () => {
          for (const release of held.splice(0)) release();
        },
      };
    }

    /** An answer that fits both of an Item's calls. */
    const answer = {
      categories: ["lead"],
      summary: "A summary",
      reasoning: "Because",
      severity: 2,
      importance: 3,
    };

    const fakeModel = (turns: number) =>
      fakeLlm("openai-compatible", Array.from({ length: turns }, () => ({ json: answer })));

    it("queues an Item whose Workspace has a model on the Agent queue, in that Workspace's group", async () => {
      modelFetch = fakeModel(4).fetch;
      const modelled = await modelWorkspace();
      const plain = await plainWorkspace();

      await pollSource(db, modelled.sourceId, answering(["one"]));
      await pollSource(db, plain.sourceId, answering(["one"]));
      const modelledItem = present((await itemIdsOf(modelled.sourceId))[0]);
      const plainItem = present((await itemIdsOf(plain.sourceId))[0]);

      const jobFor = async (itemId: string) =>
        (
          await db.$client.query<{ name: string; groupId: string | null }>(
            `select name, group_id as "groupId" from pgboss.job where data->>'itemId' = $1`,
            [itemId],
          )
        ).rows;
      expect(await jobFor(modelledItem)).toEqual([{ name: agentItemQueue, groupId: modelled.workspaceId }]);
      expect(await jobFor(plainItem)).toEqual([{ name: processItemQueue, groupId: null }]);

      // Both finish here, so neither leaves a job that would reach a later test's model.
      await vi.waitFor(
        async () => {
          for (const id of [modelledItem, plainItem]) {
            const found = await db.query.item.findFirst({ where: eq(item.id, id) });
            expect(found?.processedAt).not.toBeNull();
          }
        },
        { timeout: 30_000 },
      );
    });

    it("runs at most 2 Agent jobs at once in one Workspace", async () => {
      const model = holdingModel(fakeModel(24), () => true);
      modelFetch = model.fetch;
      const { sourceId } = await modelWorkspace("https://one.test/v1");

      try {
        await pollSource(db, sourceId, answering(["a", "b", "c", "d", "e", "f"]));
        await vi.waitFor(
          () => {
            expect(model.total()).toBe(2);
          },
          { timeout: 30_000 },
        );
        // Longer than pg-boss's 2 second poll, so a third job would have started by now.
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        expect(model.total()).toBe(2);

        await model.settle([sourceId]);
      } finally {
        model.release();
      }
      expect(model.mostIn("one.test")).toBe(2);
    });

    it("runs 4 Agent jobs at once across Workspaces", async () => {
      const model = holdingModel(fakeModel(32), () => true);
      modelFetch = model.fetch;
      const one = await modelWorkspace("https://one.test/v1");
      const two = await modelWorkspace("https://two.test/v1");

      try {
        await pollSource(db, one.sourceId, answering(["a", "b", "c", "d"]));
        await pollSource(db, two.sourceId, answering(["a", "b", "c", "d"]));

        await vi.waitFor(
          () => {
            expect(model.total()).toBe(4);
          },
          { timeout: 30_000 },
        );
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        expect(model.total()).toBe(4);

        await model.settle([one.sourceId, two.sourceId]);
      } finally {
        model.release();
      }
      expect(model.mostTotal()).toBe(4);
      expect(model.mostIn("one.test")).toBe(2);
      expect(model.mostIn("two.test")).toBe(2);
    });

    it("rates another Workspace's Item while one model hangs", async () => {
      const model = holdingModel(fakeModel(24), (host) => host === "hang.test");
      modelFetch = model.fetch;
      const hung = await modelWorkspace("https://hang.test/v1");
      const moving = await modelWorkspace("https://moving.test/v1");

      try {
        await pollSource(db, hung.sourceId, answering(["a", "b", "c", "d", "e", "f"]));
        await vi.waitFor(
          () => {
            expect(model.total()).toBe(2);
          },
          { timeout: 30_000 },
        );

        await pollSource(db, moving.sourceId, answering(["one"]));
        const movingItem = present((await itemIdsOf(moving.sourceId))[0]);
        const rated = await vi.waitFor(
          async () => {
            const found = await db.query.item.findFirst({ where: eq(item.id, movingItem) });
            expect(found?.ratedAt).not.toBeNull();
            return found;
          },
          { timeout: 15_000 },
        );
        expect(rated).toMatchObject({ severity: 2, importance: 3 });

        // The hung Workspace's calls still hold their two slots, and its Items are still waiting.
        expect(model.total()).toBe(2);
        const waiting = await db.select().from(item).where(eq(item.sourceId, hung.sourceId));
        expect(waiting.filter((row) => row.processedAt === null)).toHaveLength(6);

        await model.settle([hung.sourceId]);
      } finally {
        model.release();
      }
    });

    it("processes an Item that can't reach the Agent while every Agent slot is full", async () => {
      const model = holdingModel(fakeModel(24), () => true);
      modelFetch = model.fetch;
      const one = await modelWorkspace("https://one.test/v1");
      const two = await modelWorkspace("https://two.test/v1");
      const plain = await plainWorkspace();

      try {
        await pollSource(db, one.sourceId, answering(["a", "b"]));
        await pollSource(db, two.sourceId, answering(["a", "b"]));
        await vi.waitFor(
          () => {
            expect(model.total()).toBe(4);
          },
          { timeout: 30_000 },
        );

        await pollSource(db, plain.sourceId, answering(["one"]));
        const plainItem = present((await itemIdsOf(plain.sourceId))[0]);
        await vi.waitFor(
          async () => {
            const found = await db.query.item.findFirst({ where: eq(item.id, plainItem) });
            expect(found?.processedAt).not.toBeNull();
          },
          { timeout: 15_000 },
        );
        expect(await db.select().from(itemCategory).where(eq(itemCategory.itemId, plainItem))).toMatchObject([
          { category: "plain" },
        ]);
        // The four Agent calls still hold every Agent slot.
        expect(model.total()).toBe(4);

        await model.settle([one.sourceId, two.sourceId]);
      } finally {
        model.release();
      }
    });

    it("retries a job whose call failed, with the failure in the Log and the Item visible", async () => {
      modelFetch = fakeLlm("openai-compatible", [{ status: 500, message: "Down\0" }]).fetch;
      const { sourceId } = await modelWorkspace();

      await pollSource(db, sourceId, answering(["one"]));
      const itemId = present((await itemIdsOf(sourceId))[0]);

      await vi.waitFor(
        async () => {
          const { rows } = await db.$client.query<{ state: string }>(
            "select state from pgboss.job where name = $1 and data->>'itemId' = $2",
            [agentItemQueue, itemId],
          );
          expect(rows[0]?.state).toBe("retry");
        },
        { timeout: 30_000 },
      );

      const log = await db.select().from(itemLog).where(eq(itemLog.itemId, itemId));
      expect(log.map((row) => row.message)).toContainEqual(
        expect.stringContaining("The classify call failed"),
      );
      const calls = await db.select().from(agentCall).where(eq(agentCall.itemId, itemId));
      expect(calls).toMatchObject([{ purpose: "classify", status: "error" }]);
      const visible = await db.query.item.findFirst({ where: eq(item.id, itemId) });
      expect(visible).toMatchObject({ classifiedAt: null, processedAt: null });
    });

    it("finishes the Item when its job has no retries left", async () => {
      modelFetch = fakeLlm("openai-compatible", [{ status: 500 }]).fetch;
      const { sourceId } = await modelWorkspace();
      await pollSource(db, sourceId, { ...answering(["one"]), enqueueItems: () => Promise.resolve() });
      const itemId = present((await itemIdsOf(sourceId))[0]);

      await boss.send(agentItemQueue, { itemId }, { retryLimit: 0 });

      await vi.waitFor(
        async () => {
          const found = await db.query.item.findFirst({ where: eq(item.id, itemId) });
          expect(found?.processedAt).not.toBeNull();
        },
        { timeout: 30_000 },
      );
    });

    it("gives both queues the Agent's retries and time, on an upgraded install too", async () => {
      for (const queue of [processItemQueue, agentItemQueue]) {
        await boss.updateQueue(queue, { expireInSeconds: 120, retryLimit: 1 });
      }

      await createPipelineQueue(boss);

      for (const queue of [processItemQueue, agentItemQueue]) {
        expect(await boss.getQueue(queue)).toMatchObject({
          expireInSeconds: 600,
          retryLimit: 3,
          retryBackoff: true,
        });
      }
    });
  });
});
