import { pollSource } from "@watchdog/core";
import {
  classifier,
  closeDb,
  createDb,
  type Db,
  eq,
  item,
  itemCategory,
  migrate,
  source,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres, type TestPostgres } from "@watchdog/db/testing";
import { PgBoss } from "pg-boss";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { itemEnqueuer, processItemQueue, startPipeline } from "./pipeline.ts";

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
    await startPipeline(db, boss);
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
});
