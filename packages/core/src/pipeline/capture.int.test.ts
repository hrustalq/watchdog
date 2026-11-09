import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { closeDb, createDb, type Db, eq, item, migrate, source, user, workspace } from "@watchdog/db";
import { startPostgres, type TestPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { loadConfig } from "../config.ts";
import { createEgressFetch } from "../egress/egress.ts";
import { sourceTypes } from "../sources/types.ts";
import { captureItems, pollSource, type PollSourceDeps } from "./capture.ts";

const now = new Date("2026-11-03T15:00:00Z");
const day = 24 * 60 * 60 * 1000;
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000);

interface Entry {
  id: string;
  published?: Date;
}

/** An RSS feed with one item per entry, in the order given. */
const rss = (entries: Entry[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>Synthetic</title>` +
  entries
    .map(
      ({ id, published }) =>
        `<item><guid>${id}</guid><link>https://feeds.test/${id}</link>` +
        `<title>Release notes for build ${id}</title>` +
        `<description>The build ${id} ships with a faster parser and fewer crashes.</description>` +
        (published ? `<pubDate>${published.toUTCString()}</pubDate>` : "") +
        `</item>`,
    )
    .join("") +
  `</channel></rss>`;

/** `count` entries, one an hour apart, the first `firstHoursAgo` hours before `now`. */
const hourly = (prefix: string, count: number, firstHoursAgo = 1) =>
  Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${String(i)}`,
    published: hoursAgo(firstHoursAgo + i),
  }));

/** The value, which the test expects to be there. */
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}

const fixture = (name: string) =>
  readFileSync(new URL(`../sources/rss/fixtures/${name}`, import.meta.url));

// No live HTTP: each Source's feed URL answers with whatever the test sets for it.
const responses = new Map<string, () => Response>();
const deps: PollSourceDeps = {
  fetch: (input) => {
    const respond = responses.get(String(input));
    return respond ? Promise.resolve(respond()) : Promise.reject(new Error("connect ECONNREFUSED"));
  },
  now: () => now,
  enqueueItems: () => Promise.resolve(),
  secrets: { encryptionKey: Buffer.alloc(32), authSecret: "unused-by-rss-sources" },
};
const serve = (url: string, body: string | Buffer, init?: ResponseInit) => {
  responses.set(url, () => new Response(body, init));
};

describe("pollSource", () => {
  let postgres: TestPostgres;
  let db: Db;
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
    return async () => {
      await closeDb(db);
      await postgres.stop();
    };
  }, 120_000);

  /** A new RSS Source whose feed is at its own URL. */
  async function newSource(name = "Release feed") {
    const url = `https://feeds.test/${crypto.randomUUID()}.rss`;
    const [created] = await db
      .insert(source)
      .values({ workspaceId, type: "rss", name, config: { url }, schedule: "*/15 * * * *" })
      .returning();
    return { ...present(created), url };
  }

  const itemsOf = (sourceId: string) =>
    db.query.item.findMany({ where: eq(item.sourceId, sourceId), with: { log: true } });
  const reload = async (sourceId: string) =>
    present(await db.query.source.findFirst({ where: eq(source.id, sourceId) }));

  it("captures the last 7 days of a new Source as a Backfill, with a capture Log", async () => {
    const src = await newSource();
    // 120 entries, one every 5.7 hours: the newest 30 are within 7 days.
    const entries = Array.from({ length: 120 }, (_, i) => ({
      id: `e-${String(i)}`,
      published: hoursAgo(1 + i * 5.7),
    }));
    serve(src.url, rss(entries));

    expect(await pollSource(db, src.id, deps)).toEqual({ captured: 30 });

    const items = await itemsOf(src.id);
    expect(items).toHaveLength(30);
    for (const captured of items) {
      expect(captured.isBackfill).toBe(true);
      expect(captured.publishedAt?.getTime()).toBeGreaterThanOrEqual(now.getTime() - 7 * day);
      expect(captured.language).toBe("en");
      expect(captured.workspaceId).toBe(workspaceId);
      expect(captured.summary).toBeNull();
      expect(captured.log).toHaveLength(1);
      expect(captured.log[0]).toMatchObject({
        stage: "capture",
        message: "Captured from Release feed as part of the Backfill",
        data: { sourceId: src.id, fetchedAt: now.toISOString() },
      });
    }
    const after = await reload(src.id);
    expect(after.backfilledAt).toEqual(now);
    expect(after.lastPolledAt).toEqual(now);
    expect(after.lastError).toBeNull();
  });

  it("caps a Backfill at the 50 newest entries", async () => {
    const src = await newSource();
    serve(src.url, rss(hourly("e", 80)));

    expect(await pollSource(db, src.id, deps)).toEqual({ captured: 50 });

    const ids = (await itemsOf(src.id)).map((captured) => captured.externalId).sort();
    expect(ids).toEqual(hourly("e", 50).map((e) => e.id).sort());
  });

  it("later captures only entries new since the Backfill, never ones it left out", async () => {
    const src = await newSource();
    const first = [
      ...hourly("e", 80),
      { id: "old", published: new Date(now.getTime() - 8 * day) },
      { id: "undated" },
    ];
    serve(src.url, rss(first));
    await pollSource(db, src.id, deps);

    const fresh = [
      { id: "new-1", published: new Date(now.getTime() + 60_000) },
      { id: "new-2", published: new Date(now.getTime() + 120_000) },
      { id: "new-undated" },
    ];
    // An entry the Backfill left out by date comes back with a fresh date, as an Atom entry does
    // when its <updated> moves: it still stays out.
    const moved = { id: "old", published: new Date(now.getTime() + 180_000) };
    const redated = first.map((e) => (e.id === "old" ? moved : e));
    serve(src.url, rss([...fresh, ...redated]));
    expect(await pollSource(db, src.id, deps)).toEqual({ captured: 3 });

    const later = (await itemsOf(src.id)).filter((captured) => !captured.isBackfill);
    expect(later.map((captured) => captured.externalId).sort()).toEqual(
      ["new-1", "new-2", "new-undated"].sort(),
    );
    expect(later[0]?.log[0]?.message).toBe("Captured from Release feed");
    // The Backfill's 50 plus the three new ones: nothing the Backfill left out came in later.
    expect(await itemsOf(src.id)).toHaveLength(53);
  });

  it("captures a recorded feed's entries with their fields", async () => {
    const src = await newSource("Hacker News");
    serve(src.url, fixture("hnrss.rss"), { headers: { etag: '"v1"' } });

    expect(await pollSource(db, src.id, deps)).toEqual({ captured: 3 });

    const items = await itemsOf(src.id);
    for (const captured of items) {
      expect(captured.language).toBe("en");
      expect(captured.url).toMatch(/^https:\/\//);
    }
    expect(items[0]?.log[0]?.message).toBe("Captured from Hacker News as part of the Backfill");
    expect((await reload(src.id)).fetchState).toEqual({ etag: '"v1"' });
  });

  it("never creates a second Item for the same entry, sequentially or concurrently", async () => {
    const sequential = await newSource();
    serve(sequential.url, rss(hourly("e", 10)));
    await pollSource(db, sequential.id, deps);
    expect(await pollSource(db, sequential.id, deps)).toEqual({ captured: 0 });
    expect(await itemsOf(sequential.id)).toHaveLength(10);

    const concurrent = await newSource();
    serve(concurrent.url, rss(hourly("e", 80)));
    const results = await Promise.all([1, 2, 3].map(() => pollSource(db, concurrent.id, deps)));

    expect(results.map((result) => ("captured" in result ? result.captured : -1)).sort()).toEqual([
      0, 0, 50,
    ]);
    const items = await itemsOf(concurrent.id);
    expect(items).toHaveLength(50);
    expect(items.every((captured) => captured.log.length === 1)).toBe(true);
  });

  it("records a failed poll without throwing, and the next success clears it", async () => {
    const src = await newSource();

    // A network error: no response is set for this URL.
    expect(await pollSource(db, src.id, deps)).toEqual({ error: "connect ECONNREFUSED" });
    let after = await reload(src.id);
    expect(after.lastError).toBe("connect ECONNREFUSED");
    expect(after.lastErrorAt).toEqual(now);
    expect(after.lastPolledAt).toBeNull();
    expect(after.backfilledAt).toBeNull();

    serve(src.url, "Bad gateway", { status: 502, statusText: "Bad Gateway" });
    expect(await pollSource(db, src.id, deps)).toEqual({
      error: `${src.url} answered 502 Bad Gateway`,
    });

    serve(src.url, fixture("html-page.html"), { headers: { "content-type": "text/html" } });
    expect(await pollSource(db, src.id, deps)).toEqual({
      error: `${src.url} is not an RSS or Atom feed`,
    });
    expect(await itemsOf(src.id)).toEqual([]);

    serve(src.url, rss(hourly("e", 2)));
    expect(await pollSource(db, src.id, deps)).toEqual({ captured: 2 });
    after = await reload(src.id);
    expect(after.lastError).toBeNull();
    expect(after.lastErrorAt).toBeNull();
    expect(after.lastPolledAt).toEqual(now);
  });

  /** The egress guard's fetch, with every host resolving to `address`. */
  const guardedFetch = (address: string, allowlist = "") => {
    const env = {
      DATABASE_URL: postgres.url,
      BETTER_AUTH_SECRET: "a".repeat(32),
      BETTER_AUTH_URL: "http://localhost:3000",
      WATCHDOG_ENCRYPTION_KEY: "A".repeat(43) + "=",
      EGRESS_ALLOWLIST: allowlist,
    };
    const lookup = () => Promise.resolve([{ address, family: 4 }]);
    return createEgressFetch(loadConfig(env, () => undefined), { lookup });
  };

  it("records why a connection failed, not only that it did", async () => {
    const src = await newSource();
    // A port that was just free and is now closed, on loopback, which the allowlist lets
    // feeds.test reach.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = z.object({ port: z.number() }).parse(closed.address());
    await new Promise((resolve) => closed.close(resolve));
    await db
      .update(source)
      .set({ config: { url: `http://feeds.test:${String(port)}/feed.rss` } })
      .where(eq(source.id, src.id));

    const fetch = guardedFetch("127.0.0.1", "feeds.test");
    const result = await pollSource(db, src.id, { ...deps, fetch });

    const { lastError } = await reload(src.id);
    expect(lastError).toMatch(/^fetch failed: .*ECONNREFUSED/);
    expect(result).toEqual({ error: lastError });
  });

  it("records an egress block as a failed poll", async () => {
    const src = await newSource();

    // A private address, which the guard refuses before connecting.
    const result = await pollSource(db, src.id, { ...deps, fetch: guardedFetch("10.0.0.1") });

    const { lastError } = await reload(src.id);
    expect(lastError).toContain("10.0.0.1");
    expect(result).toEqual({ error: lastError });
    expect(await itemsOf(src.id)).toEqual([]);
  });

  it("captures an entry holding a NUL, which Postgres text and jsonb refuse", async () => {
    const src = await newSource();
    const published = hoursAgo(1).toUTCString();
    serve(
      src.url,
      `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><item><guid>nul</guid>` +
        `<title>Null\u0000byte</title><description>A\u0000B</description>` +
        `<pubDate>${published}</pubDate></item></channel></rss>`,
    );

    expect(await pollSource(db, src.id, deps)).toEqual({ captured: 1 });
    const [captured] = await itemsOf(src.id);
    expect([captured?.title, captured?.body]).toEqual(["Nullbyte", "AB"]);
  });

  it("treats a 304 as a successful poll that captures nothing", async () => {
    const src = await newSource();
    serve(src.url, rss(hourly("e", 3)), { headers: { etag: '"v1"' } });
    await pollSource(db, src.id, deps);

    let conditional: Headers | undefined;
    responses.set(src.url, () => new Response(null, { status: 304 }));
    const result = await pollSource(db, src.id, {
      ...deps,
      fetch: (input, init) => {
        conditional = new Headers(init?.headers);
        return deps.fetch(input, init);
      },
    });

    expect(result).toEqual({ captured: 0 });
    expect(conditional?.get("if-none-match")).toBe('"v1"');
    expect(await itemsOf(src.id)).toHaveLength(3);
    expect((await reload(src.id)).fetchState).toEqual({ etag: '"v1"' });
  });

  it("captures every draft a type without a Backfill pushes, however old or undated", async () => {
    // A push type of the test's own, standing in for the webhook inbox: it takes no Backfill.
    sourceTypes.webhook = { config: z.object({}), backfill: null };
    onTestFinished(() => {
      delete sourceTypes.webhook;
    });
    const [inbox] = await db
      .insert(source)
      .values({ workspaceId, type: "webhook", name: "Inbox", config: {}, schedule: null, nextPollAt: null })
      .returning();
    const src = present(inbox);
    const draft = (id: string, publishedAt: Date | null) => ({
      externalId: id,
      url: null,
      title: null,
      author: null,
      body: `The pushed payload ${id} names a release with a faster parser.`,
      publishedAt,
      raw: {},
    });
    // 60 drafts, over the cap of 50, most of them older than 7 days, and one undated.
    const drafts = [...hourly("p", 59, 24 * 30).map(({ id, published }) => draft(id, published)), draft("undated", null)];
    const push = (batch: typeof drafts) =>
      captureItems(db, src.id, batch, { at: now, polled: false }, deps);

    expect(await push(drafts)).toEqual({ captured: 60 });
    const items = await itemsOf(src.id);
    expect(items.every((captured) => !captured.isBackfill)).toBe(true);
    expect(items.every((captured) => captured.log.length === 1)).toBe(true);
    expect(await push([...drafts, draft("new", null)])).toEqual({ captured: 1 });
    expect((await reload(src.id)).backfilledAt).toBeNull();
  });
});
