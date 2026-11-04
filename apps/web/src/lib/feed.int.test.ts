import { createServer } from "node:http";
import { createEgressFetch, loadConfig, pollSource } from "@watchdog/core";
import { closeDb, createDb, type Db, item, itemLog, migrate, source, sql, user, workspace } from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { feedPage, feedPageSize, itemWithLog, parseCursor } from "./feed.ts";

const now = new Date("2026-11-03T15:00:00Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000);

/** The value, which the test expects to be there. */
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}

// No live HTTP: a server on loopback answers for feeds.test, which the allowlist lets through.
let feed = "";
const feeds = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/rss+xml" }).end(feed);
});
const env = {
  DATABASE_URL: "postgres://unused",
  BETTER_AUTH_SECRET: "a".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3000",
  WATCHDOG_ENCRYPTION_KEY: "A".repeat(43) + "=",
  EGRESS_ALLOWLIST: "feeds.test",
};
const lookup = () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]);
const deps = {
  fetch: createEgressFetch(loadConfig(env, () => undefined), { lookup }),
  now: () => now,
  enqueueItems: () => Promise.resolve(),
};

describe("Feed", () => {
  let db: Db;
  let feedUrl = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => feeds.listen(0, "127.0.0.1", resolve));
    const address = feeds.address();
    if (address === null || typeof address === "string") throw new Error("The server has no port");
    feedUrl = `http://feeds.test:${String(address.port)}/feed.rss`;
    const postgres = await startPostgres();
    await migrate(postgres.url);
    db = createDb(postgres.url);
    return async () => {
      await closeDb(db);
      await postgres.stop();
      feeds.close();
    };
  }, 120_000);

  /** A Workspace with one RSS Source. */
  async function seed(sourceName = "Release notes") {
    const id = crypto.randomUUID();
    await db.insert(user).values({ id, name: "Owner", email: `${id}@example.com` });
    const [ws] = await db.insert(workspace).values({ name: "Workspace", ownerUserId: id }).returning();
    const [src] = await db
      .insert(source)
      .values({
        workspaceId: present(ws).id,
        type: "rss",
        name: sourceName,
        config: { url: feedUrl },
        schedule: "*/15 * * * *",
      })
      .returning();
    return { workspaceId: present(ws).id, source: present(src) };
  }

  /** Inserts Items into a Source and returns their ids, in the order given. */
  async function insertItems(
    { workspaceId, source: src }: Awaited<ReturnType<typeof seed>>,
    rows: { capturedAt?: Date; publishedAt?: Date | null; title?: string }[],
  ) {
    const inserted = await db
      .insert(item)
      .values(
        rows.map((row, index) => ({
          workspaceId,
          sourceId: src.id,
          externalId: crypto.randomUUID(),
          title: row.title ?? `Item ${String(index)}`,
          body: "An entry.",
          raw: {},
          ...(row.capturedAt === undefined ? {} : { capturedAt: row.capturedAt }),
          publishedAt: row.publishedAt ?? null,
        })),
      )
      .returning({ id: item.id });
    return inserted.map((row) => row.id);
  }

  /** Every page of the Feed, following "Show older" to the end. */
  async function allPages(workspaceId: string) {
    const pages = [];
    let before: string | undefined;
    do {
      const page = await feedPage(db, workspaceId, parseCursor(before));
      pages.push(page.items.map((row) => row.id));
      before = page.older ?? undefined;
      // A cursor parseCursor rejects would load the newest page again, forever.
      if (before !== undefined) expect(parseCursor(before)).toBeDefined();
    } while (before !== undefined);
    return pages;
  }

  it("shows a Source's Backfill after its first poll, marked as Backfill and newest first", async () => {
    const seeded = await seed("Synthetic");
    const entries = [3, 1, 2].map((hours) => ({ id: `build-${String(hours)}`, published: hoursAgo(hours) }));
    feed =
      `<?xml version="1.0"?><rss version="2.0"><channel><title>Synthetic</title>` +
      entries
        .map(
          ({ id, published }) =>
            `<item><guid>${id}</guid><link>https://feeds.test/${id}</link><title>${id}</title>` +
            `<description>The ${id} release ships a faster parser.</description>` +
            `<pubDate>${published.toUTCString()}</pubDate></item>`,
        )
        .join("") +
      `</channel></rss>`;
    expect(await pollSource(db, seeded.source.id, deps)).toEqual({ captured: 3 });

    const { items, older } = await feedPage(db, seeded.workspaceId);
    expect(items.map((row) => row.title)).toEqual(["build-1", "build-2", "build-3"]);
    expect(items.every((row) => row.isBackfill)).toBe(true);
    expect(items[0]).toMatchObject({
      sourceName: "Synthetic",
      publishedAt: hoursAgo(1),
      excerpt: "The build-1 release ships a faster parser.",
    });
    expect(older).toBeNull();
  });

  it("orders newest captured first, then newest published with undated last, then by id", async () => {
    const seeded = await seed();
    const [old, undated, newer, newest, tied] = await insertItems(seeded, [
      { capturedAt: hoursAgo(5), publishedAt: hoursAgo(1) },
      { capturedAt: hoursAgo(1), publishedAt: null },
      { capturedAt: hoursAgo(1), publishedAt: hoursAgo(3) },
      { capturedAt: hoursAgo(1), publishedAt: hoursAgo(2) },
      { capturedAt: hoursAgo(1), publishedAt: hoursAgo(3) },
    ]);
    const [first, second] = [present(newer), present(tied)].sort().reverse();

    const { items } = await feedPage(db, seeded.workspaceId);

    expect(items.map((row) => row.id)).toEqual([newest, first, second, undated, old]);
  });

  it("pages through 200 Items with no duplicates or gaps", async () => {
    const seeded = await seed();
    // Ties on every sort key, and captured times with microseconds, which a JS Date can't hold.
    const ids = await insertItems(
      seeded,
      Array.from({ length: 150 }, (_, i) => ({
        capturedAt: hoursAgo(i % 3),
        publishedAt: i % 4 === 0 ? null : hoursAgo(i % 5),
      })),
    );
    for (let i = 0; i < 50; i++) ids.push(...(await insertItems(seeded, [{}])));
    const expected = await db.execute<{ id: string }>(sql`
      select id from item where workspace_id = ${seeded.workspaceId}
      order by captured_at desc, coalesce(published_at, '-infinity') desc, id desc`);

    const pages = await allPages(seeded.workspaceId);

    expect(pages.map((page) => page.length)).toEqual([feedPageSize, feedPageSize, feedPageSize, feedPageSize]);
    expect(pages.flat()).toEqual(expected.rows.map((row) => row.id));
    expect(new Set(pages.flat())).toEqual(new Set(ids));
  });

  it("keeps paging from a cursor whose Item has been deleted", async () => {
    const seeded = await seed();
    await insertItems(
      seeded,
      Array.from({ length: feedPageSize + 10 }, (_, i) => ({ capturedAt: hoursAgo(i % 4) })),
    );
    const expected = await allPages(seeded.workspaceId);
    const first = await feedPage(db, seeded.workspaceId);
    const last = present(first.items.at(-1));

    await db.delete(item).where(sql`${item.id} = ${last.id}`);
    const next = await feedPage(db, seeded.workspaceId, parseCursor(first.older));

    expect(next.items.map((row) => row.id)).toEqual(expected[1]);
    expect(next.older).toBeNull();
  });

  it("shows only the Workspace's own Items", async () => {
    const ours = await seed();
    const theirs = await seed();
    const [mine] = await insertItems(ours, [{ capturedAt: hoursAgo(2) }]);
    await insertItems(theirs, [{ capturedAt: hoursAgo(1) }]);
    const later = parseCursor(`2999-01-01T00:00:00.000000Z_-infinity_${crypto.randomUUID()}`);

    expect((await feedPage(db, ours.workspaceId)).items.map((row) => row.id)).toEqual([mine]);
    expect((await feedPage(db, ours.workspaceId, later)).items.map((row) => row.id)).toEqual([mine]);
  });

  it("shows the newest page for a malformed cursor", async () => {
    const seeded = await seed();
    const [newest] = await insertItems(seeded, [{ capturedAt: hoursAgo(1) }]);

    // An Item id was the cursor before it carried the sort keys, so old links land here too.
    for (const before of ["not-a-cursor", present(newest), "2026-02-30T00:00:00.000000Z_-infinity_x"]) {
      const page = await feedPage(db, seeded.workspaceId, parseCursor(before));
      expect(page.items.map((row) => row.id)).toEqual([newest]);
    }
  });

  it("loads an Item's envelope and its Log, oldest first", async () => {
    const seeded = await seed("Hacker News");
    const [id] = await insertItems(seeded, [{ publishedAt: hoursAgo(1), title: "A launch" }]);
    await db.insert(itemLog).values([
      { itemId: present(id), stage: "capture", message: "Later", at: hoursAgo(1) },
      { itemId: present(id), stage: "capture", message: "Captured from Hacker News", at: hoursAgo(2) },
    ]);

    const loaded = await itemWithLog(db, seeded.workspaceId, present(id));

    expect(loaded).toMatchObject({
      id,
      title: "A launch",
      body: "An entry.",
      publishedAt: hoursAgo(1),
      isBackfill: false,
      source: { name: "Hacker News" },
    });
    expect(loaded?.log.map((row) => [row.stage, row.message])).toEqual([
      ["capture", "Captured from Hacker News"],
      ["capture", "Later"],
    ]);
  });

  it("treats another Workspace's Item, or an id that isn't one, as missing", async () => {
    const ours = await seed();
    const theirs = await seed();
    const [other] = await insertItems(theirs, [{}]);

    expect(await itemWithLog(db, ours.workspaceId, present(other))).toBeUndefined();
    expect(await itemWithLog(db, ours.workspaceId, "not-a-uuid")).toBeUndefined();
  });
});
