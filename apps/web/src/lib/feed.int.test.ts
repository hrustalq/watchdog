import { createServer } from "node:http";
import { createEgressFetch, loadConfig, pollSource } from "@watchdog/core";
import {
  closeDb,
  createDb,
  type Db,
  eq,
  extractorRule,
  item,
  itemCategory,
  itemField,
  itemLog,
  migrate,
  source,
  sql,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { feedPage, feedPageSize, itemWithLog, parseCursor, parseTopCursor, topPage } from "./feed.ts";

const now = new Date("2026-11-03T15:00:00Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000);
// Top's window runs on the database's clock, so its tests date Items from the real time.
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

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
    rows: { capturedAt?: Date; publishedAt?: Date | null; title?: string; importance?: number; severity?: number }[],
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
          importance: row.importance ?? null,
          severity: row.severity ?? null,
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

  it("shows an Item the pipeline finished unrated, as when a model keeps failing", async () => {
    const seeded = await seed();
    const [itemId] = await insertItems(seeded, [{}]);
    await db
      .update(item)
      .set({ processedAt: now })
      .where(eq(item.id, present(itemId)));

    expect((await feedPage(db, seeded.workspaceId)).items.map((row) => row.id)).toEqual([itemId]);
  });

  it("gives a row its Rating, sorted Categories and summary, loading the whole page in one query", async () => {
    const seeded = await seed();
    const [rated, unrated] = await insertItems(seeded, [{ capturedAt: hoursAgo(1) }, { capturedAt: hoursAgo(2) }]);
    // No rated_at, as after a Correction: the Rating is whatever severity and importance hold.
    await db
      .update(item)
      .set({ severity: 4, importance: 2, summary: "What it says" })
      .where(eq(item.id, present(rated)));
    await db.insert(itemCategory).values([
      { itemId: present(rated), category: "release" },
      { itemId: present(rated), category: "bug-report" },
    ]);

    const query = vi.spyOn(db.$client, "query");
    const { items } = await feedPage(db, seeded.workspaceId);
    expect(query).toHaveBeenCalledTimes(1);
    query.mockRestore();

    expect(items[0]).toMatchObject({
      id: rated,
      severity: 4,
      importance: 2,
      categories: ["bug-report", "release"],
      excerpt: "What it says",
    });
    expect(items[1]).toMatchObject({
      id: unrated,
      severity: null,
      importance: null,
      categories: [],
      excerpt: "An entry.",
    });
  });

  it("caps a row's summary, which a model can run on", async () => {
    const seeded = await seed();
    const [id] = await insertItems(seeded, [{}]);
    await db
      .update(item)
      .set({ summary: "x".repeat(5000) })
      .where(eq(item.id, present(id)));

    const { items } = await feedPage(db, seeded.workspaceId);

    expect(items[0]?.excerpt).toHaveLength(300);
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

  describe("Top", () => {
    const topIds = async (workspaceId: string) =>
      (await topPage(db, workspaceId)).items.map((row) => row.id);

    it("ranks Importance 5 / Severity 1 (11) above a newer Importance 3 / Severity 4 (10)", async () => {
      const seeded = await seed();
      const [eleven, ten] = await insertItems(seeded, [
        { importance: 5, severity: 1, capturedAt: daysAgo(3) },
        { importance: 3, severity: 4, capturedAt: daysAgo(1) },
      ]);

      expect(await topIds(seeded.workspaceId)).toEqual([eleven, ten]);
    });

    it("breaks a tie by newest captured, then by id", async () => {
      const seeded = await seed();
      const capturedAt = daysAgo(2);
      const [older, newer, tiedA, tiedB] = await insertItems(seeded, [
        { importance: 3, severity: 3, capturedAt: daysAgo(3) },
        { importance: 4, severity: 1, capturedAt: daysAgo(1) },
        { importance: 2, severity: 5, capturedAt },
        { importance: 2, severity: 5, capturedAt },
      ]);
      const [first, second] = [present(tiedA), present(tiedB)].sort().reverse();

      expect(await topIds(seeded.workspaceId)).toEqual([newer, first, second, older]);
    });

    it("keeps to the last 7 days by captured_at, whatever the published date", async () => {
      const seeded = await seed();
      const [inside, justInside, justOutside, eightDays] = await insertItems(seeded, [
        { importance: 1, severity: 1, capturedAt: daysAgo(1), publishedAt: daysAgo(30) },
        { importance: 2, severity: 2, capturedAt: new Date(daysAgo(7).getTime() + 60_000) },
        { importance: 5, severity: 5, capturedAt: new Date(daysAgo(7).getTime() - 60_000) },
        { importance: 5, severity: 5, capturedAt: daysAgo(8) },
      ]);

      expect(await topIds(seeded.workspaceId)).toEqual([justInside, inside]);
      const latest = (await feedPage(db, seeded.workspaceId)).items.map((row) => row.id);
      expect(latest).toEqual([inside, justInside, justOutside, eightDays]);
    });

    it("leaves an unrated Item to Latest until it's rated, and follows a change to the Rating", async () => {
      const seeded = await seed();
      const [other, later] = await insertItems(seeded, [
        { importance: 3, severity: 3, capturedAt: daysAgo(1) },
        { capturedAt: daysAgo(2) },
      ]);
      const rate = (importance: number, severity: number) =>
        db.update(item).set({ importance, severity }).where(eq(item.id, present(later)));

      expect(await topIds(seeded.workspaceId)).toEqual([other]);
      await rate(1, 1);
      expect(await topIds(seeded.workspaceId)).toEqual([other, later]);
      await rate(5, 5);
      expect(await topIds(seeded.workspaceId)).toEqual([later, other]);
    });

    it("falls back to Latest order when no Item in the window is rated", async () => {
      const seeded = await seed();
      const [old, newest, middle] = await insertItems(seeded, [
        { importance: 5, severity: 5, capturedAt: daysAgo(8) },
        { capturedAt: daysAgo(1) },
        { capturedAt: daysAgo(2) },
      ]);

      const page = await topPage(db, seeded.workspaceId);

      expect(page.items.map((row) => row.id)).toEqual([newest, middle, old]);
      expect(page.fallback).toBe(true);
    });

    it("carries on the fallback's pages with a Latest cursor", async () => {
      const seeded = await seed();
      await insertItems(seeded, Array.from({ length: feedPageSize + 1 }, () => ({})));

      const { older, fallback } = await topPage(db, seeded.workspaceId);

      expect(fallback).toBe(true);
      expect(parseCursor(older)).toBeDefined();
    });

    it("doesn't fall back once an Item in the window is rated", async () => {
      const seeded = await seed();
      const [rated] = await insertItems(seeded, [{ importance: 1, severity: 1 }, {}]);

      const page = await topPage(db, seeded.workspaceId);

      expect(page.items.map((row) => row.id)).toEqual([rated]);
      expect(page.fallback).toBe(false);
    });

    it("shows only the Workspace's own Items", async () => {
      const ours = await seed();
      const theirs = await seed();
      const [mine] = await insertItems(ours, [{ importance: 1, severity: 1 }]);
      await insertItems(theirs, [{ importance: 5, severity: 5 }]);

      expect(await topIds(ours.workspaceId)).toEqual([mine]);
      const later = parseTopCursor(`15_2999-01-01T00:00:00.000000Z_${crypto.randomUUID()}`);
      expect((await topPage(db, ours.workspaceId, later)).items.map((row) => row.id)).toEqual([mine]);
    });

    /** Every page of Top, following "Show older" to the end. */
    async function allTopPages(workspaceId: string) {
      const pages = [];
      let before: string | undefined;
      do {
        const page = await topPage(db, workspaceId, parseTopCursor(before));
        pages.push(page.items.map((row) => row.id));
        before = page.older ?? undefined;
        // A cursor parseTopCursor rejects would load the first page again, forever.
        if (before !== undefined) expect(parseTopCursor(before)).toBeDefined();
      } while (before !== undefined);
      return pages;
    }

    it("pages through 200 rated Items with no duplicates or gaps", async () => {
      const seeded = await seed();
      // Ties on every sort key, and captured times with microseconds, which a JS Date can't hold.
      const ids = await insertItems(
        seeded,
        Array.from({ length: 150 }, (_, i) => ({
          importance: 1 + (i % 5),
          severity: 1 + (i % 3),
          capturedAt: daysAgo(1 + (i % 3)),
        })),
      );
      for (let i = 0; i < 50; i++) ids.push(...(await insertItems(seeded, [{ importance: 3, severity: 3 }])));
      const expected = await db.execute<{ id: string }>(sql`
        select id from item where workspace_id = ${seeded.workspaceId}
        order by 2 * importance + severity desc, captured_at desc, id desc`);

      const pages = await allTopPages(seeded.workspaceId);

      expect(pages.map((page) => page.length)).toEqual([feedPageSize, feedPageSize, feedPageSize, feedPageSize]);
      expect(pages.flat()).toEqual(expected.rows.map((row) => row.id));
      expect(new Set(pages.flat())).toEqual(new Set(ids));
    });

    it("moves only the Item whose score changes between pages, and paging still ends", async () => {
      const seeded = await seed();
      await insertItems(
        seeded,
        Array.from({ length: feedPageSize + 10 }, () => ({ importance: 3, severity: 3 })),
      );
      const [firstPage = [], secondPage = []] = await allTopPages(seeded.workspaceId);
      const lowered = present(firstPage.at(-1));
      const raised = present(secondPage[0]);
      const first = await topPage(db, seeded.workspaceId);

      await db.update(item).set({ importance: 1, severity: 1 }).where(eq(item.id, lowered));
      await db.update(item).set({ importance: 5, severity: 5 }).where(eq(item.id, raised));
      const next = await topPage(db, seeded.workspaceId, parseTopCursor(first.older));

      expect(next.items.map((row) => row.id)).toEqual([...secondPage.slice(1), lowered]);
      expect(next.older).toBeNull();
    });

    it("says there's nothing older rather than falling back, past the last Item", async () => {
      const seeded = await seed();
      await insertItems(seeded, [{ importance: 3, severity: 3 }]);
      const earliest = parseTopCursor(`3_2000-01-01T00:00:00.000000Z_${crypto.randomUUID()}`);

      const page = await topPage(db, seeded.workspaceId, earliest);

      expect(page).toMatchObject({ items: [], older: null, fallback: false });
    });

    it("shows the first page for a malformed cursor, which includes one from Latest", async () => {
      const seeded = await seed();
      const [only] = await insertItems(seeded, [{ importance: 3, severity: 3 }]);
      const id = crypto.randomUUID();

      for (const before of [
        "not-a-cursor",
        present(only),
        `2026-11-03T00:00:00.000000Z_-infinity_${id}`,
        `99999_2026-11-03T00:00:00.000000Z_${id}`,
        `9_2026-02-30T00:00:00.000000Z_${id}`,
        `9_2026-11-03T00:00:00.000000Z_x`,
        `9_2026-11-03T00:00:00.000000Z_${id}_extra`,
      ]) {
        const page = await topPage(db, seeded.workspaceId, parseTopCursor(before));
        expect(page.items.map((row) => row.id)).toEqual([only]);
      }
    });

    it("ignores a Top cursor in Latest", () => {
      expect(parseCursor(`9_2026-11-03T00:00:00.000000Z_${crypto.randomUUID()}`)).toBeUndefined();
    });

    it("serves the first and later pages from item_top_idx without sorting", async () => {
      const seeded = await seed();
      await insertItems(
        seeded,
        Array.from({ length: feedPageSize + 1 }, (_, i) => ({ importance: 1 + (i % 5), severity: 3 })),
      );
      const { older } = await topPage(db, seeded.workspaceId);

      /** The plan of the exact query topPage sends. */
      async function planOf(before: ReturnType<typeof parseTopCursor>) {
        const query = vi.spyOn(db.$client, "query");
        await topPage(db, seeded.workspaceId, before);
        const [config, params]: unknown[] = query.mock.calls[0] ?? [];
        query.mockRestore();
        if (typeof config !== "object" || config === null || !("text" in config)) throw new Error("No query");
        const client = await db.$client.connect();
        try {
          // Tiny tables make these scans cheapest, so forbid them to see what the order can use.
          await client.query("begin");
          await client.query("set local enable_seqscan = off");
          await client.query("set local enable_bitmapscan = off");
          const plan = await client.query<{ "QUERY PLAN": string }>(
            `explain ${String(config.text)}`,
            Array.isArray(params) ? params : [],
          );
          await client.query("rollback");
          return plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
        } finally {
          client.release();
        }
      }

      for (const plan of [await planOf(undefined), await planOf(parseTopCursor(older))]) {
        expect(plan).toContain("item_top_idx");
        expect(plan).not.toMatch(/Sort/);
      }
    });
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

  it("loads an Item's extracted fields by name, each with the rule that filled it", async () => {
    const seeded = await seed();
    const [id] = await insertItems(seeded, [{}]);
    const [rule] = await db
      .insert(extractorRule)
      .values({ workspaceId: seeded.workspaceId, name: "CVEs", kind: "deterministic", definition: {} })
      .returning();
    await db.insert(itemField).values([
      // A deleted rule leaves its field with no rule.
      { itemId: present(id), name: "tags", value: ["a", "b"] },
      { itemId: present(id), name: "cve", value: "CVE-1", extractorRuleId: present(rule).id },
    ]);

    const loaded = await itemWithLog(db, seeded.workspaceId, present(id));

    expect(loaded?.fields).toEqual([
      { name: "cve", value: "CVE-1", extractorRule: { name: "CVEs" } },
      { name: "tags", value: ["a", "b"], extractorRule: null },
    ]);
  });

  it("loads an Item's Rating, sorted Categories and summary, keeping the original text", async () => {
    const seeded = await seed();
    const [id] = await insertItems(seeded, [{}]);
    await db
      .update(item)
      .set({ severity: 5, importance: 3, summary: "<b>What</b> it says" })
      .where(eq(item.id, present(id)));
    await db.insert(itemCategory).values([
      { itemId: present(id), category: "release" },
      { itemId: present(id), category: "bug-report" },
    ]);

    const loaded = await itemWithLog(db, seeded.workspaceId, present(id));

    expect(loaded).toMatchObject({
      severity: 5,
      importance: 3,
      summary: "<b>What</b> it says",
      body: "An entry.",
      categories: [{ category: "bug-report" }, { category: "release" }],
    });
  });

  it("leaves an unrated Item with no Rating, Categories or summary", async () => {
    const seeded = await seed();
    const [id] = await insertItems(seeded, [{}]);

    const loaded = await itemWithLog(db, seeded.workspaceId, present(id));

    expect(loaded).toMatchObject({ severity: null, importance: null, summary: null, categories: [] });
  });

  it("treats another Workspace's Item, or an id that isn't one, as missing", async () => {
    const ours = await seed();
    const theirs = await seed();
    const [other] = await insertItems(theirs, [{}]);

    expect(await itemWithLog(db, ours.workspaceId, present(other))).toBeUndefined();
    expect(await itemWithLog(db, ours.workspaceId, "not-a-uuid")).toBeUndefined();
  });
});
