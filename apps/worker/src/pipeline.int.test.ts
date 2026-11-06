import { pollSource } from "@watchdog/core";
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
import { createPipelineQueue, itemEnqueuer, processItemQueue, startPipeline } from "./pipeline.ts";

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
  });

  const itemIdsOf = async (sourceId: string) =>
    (await db.select({ id: item.id }).from(item).where(eq(item.sourceId, sourceId))).map((row) => row.id);

  /** The Item id in each job on the queue, for these Items. */
  const jobsFor = async (itemIds: string[]) =>
    (
      await db.$client.query<{ itemId: string }>(
        "select data->>'itemId' as \"itemId\" from pgboss.job where name = $1 and data->>'itemId' = any($2)",
        [processItemQueue, itemIds],
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
        fetch: () => Promise.resolve(new Response(feed(["one"]))),
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
    async function modelWorkspace() {
      const id = crypto.randomUUID();
      await db.insert(user).values({ id, name: "Owner", email: `${id}@example.com` });
      const [ws] = await db.insert(workspace).values({ name: "Models", ownerUserId: id }).returning();
      const ownId = present(ws).id;
      await db.insert(modelConfig).values({
        workspaceId: ownId,
        providerType: "openai-compatible",
        baseUrl: "https://llm.test/v1",
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
      return present(created).id;
    }

    it("runs at most 4 Agent jobs at once", async () => {
      // Each of the 6 Items makes two calls, and with jobs side by side either can come next, so one
      // answer has to fit both.
      const answer = {
        categories: ["lead"],
        summary: "A summary",
        reasoning: "Because",
        severity: 2,
        importance: 3,
      };
      const fake = fakeLlm("openai-compatible", Array.from({ length: 12 }, () => ({ json: answer })));
      const held: (() => void)[] = [];
      let running = 0;
      let most = 0;
      modelFetch = async (input, init) => {
        most = Math.max(most, ++running);
        await new Promise<void>((resolve) => held.push(resolve));
        running--;
        return fake.fetch(input, init);
      };
      const sourceId = await modelWorkspace();

      await pollSource(db, sourceId, answering(["a", "b", "c", "d", "e", "f"]));
      await vi.waitFor(() => {
        expect(running).toBe(4);
      }, { timeout: 30_000 });
      // Longer than pg-boss's 2 second poll, so a fifth job would have started by now.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(running).toBe(4);

      const itemIds = await itemIdsOf(sourceId);
      await vi.waitFor(
        async () => {
          for (const release of held.splice(0)) release();
          const rows = await db.select().from(item).where(eq(item.sourceId, sourceId));
          expect(rows.filter((row) => row.processedAt !== null)).toHaveLength(itemIds.length);
        },
        { timeout: 30_000 },
      );
      expect(most).toBe(4);
    });

    it("retries a job whose call failed, with the failure in the Log and the Item visible", async () => {
      modelFetch = fakeLlm("openai-compatible", [{ status: 500, message: "Down\0" }]).fetch;
      const sourceId = await modelWorkspace();

      await pollSource(db, sourceId, answering(["one"]));
      const itemId = present((await itemIdsOf(sourceId))[0]);

      await vi.waitFor(
        async () => {
          const { rows } = await db.$client.query<{ state: string }>(
            "select state from pgboss.job where name = $1 and data->>'itemId' = $2",
            [processItemQueue, itemId],
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
      const sourceId = await modelWorkspace();
      await pollSource(db, sourceId, { fetch: answering(["one"]).fetch, enqueueItems: () => Promise.resolve() });
      const itemId = present((await itemIdsOf(sourceId))[0]);

      await boss.send(processItemQueue, { itemId }, { retryLimit: 0 });

      await vi.waitFor(
        async () => {
          const found = await db.query.item.findFirst({ where: eq(item.id, itemId) });
          expect(found?.processedAt).not.toBeNull();
        },
        { timeout: 30_000 },
      );
    });

    it("gives the queue the Agent's retries and time, on an upgraded install too", async () => {
      await boss.updateQueue(processItemQueue, { expireInSeconds: 120, retryLimit: 1 });

      await createPipelineQueue(boss);

      expect(await boss.getQueue(processItemQueue)).toMatchObject({
        expireInSeconds: 600,
        retryLimit: 3,
        retryBackoff: true,
      });
    });
  });
});
