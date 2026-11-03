import { createEgressFetch, loadConfig } from "@watchdog/core";
import {
  createDb,
  type Db,
  eq,
  item,
  itemLog,
  lte,
  migrate,
  source,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { addRssSource, listSources, removeSource, type SourceDeps } from "./sources.ts";

const feedUrl = "https://feeds.test/news.rss";
const feed =
  `<?xml version="1.0"?><rss version="2.0"><channel><title>Release notes</title>` +
  `<item><guid>one</guid><title>One</title><description>An entry.</description></item>` +
  `</channel></rss>`;

// No live HTTP: a URL answers with whatever the test sets for it, and any other is refused.
const responses = new Map<string, () => Response>();
const fakeFetch: SourceDeps["fetch"] = (input) => {
  const respond = responses.get(String(input));
  if (respond) return Promise.resolve(respond());
  const refused = new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
  return Promise.reject(refused);
};
responses.set(feedUrl, () => new Response(feed, { headers: { "content-type": "application/rss+xml" } }));
responses.set("https://feeds.test/page.html", () => new Response("<!doctype html><p>A page</p>"));
responses.set("https://feeds.test/gone.rss", () => new Response("", { status: 404, statusText: "Not Found" }));

const selfHosted: SourceDeps = { fetch: fakeFetch, mode: "self-hosted" };

describe("Sources", () => {
  let db: Db;
  let ours = "";
  let theirs = "";

  beforeAll(async () => {
    const postgres = await startPostgres();
    await migrate(postgres.url);
    db = createDb(postgres.url);
    await db.insert(user).values([
      { id: "us", name: "Us", email: "us@example.com" },
      { id: "them", name: "Them", email: "them@example.com" },
    ]);
    const [a, b] = await db
      .insert(workspace)
      .values([
        { name: "Ours", ownerUserId: "us" },
        { name: "Theirs", ownerUserId: "them" },
      ])
      .returning();
    ours = a?.id ?? "";
    theirs = b?.id ?? "";
    return async () => {
      await db.$client.end();
      await postgres.stop();
    };
  }, 120_000);

  const sourcesIn = (workspaceId: string) =>
    db.select().from(source).where(eq(source.workspaceId, workspaceId));

  async function added(workspaceId: string, input: { url: string; name?: string; schedule?: string }) {
    const result = await addRssSource(db, selfHosted, workspaceId, {
      name: "",
      schedule: "*/15 * * * *",
      ...input,
    });
    if (!("source" in result)) throw new Error(`Not added: ${result.error}`);
    return result.source;
  }

  it("saves a valid feed URL as a Source the worker's next tick polls", async () => {
    const before = new Date();
    const { id } = await added(ours, { url: feedUrl });

    const [saved] = await db.select().from(source).where(eq(source.id, id));
    expect(saved).toMatchObject({
      workspaceId: ours,
      type: "rss",
      name: "Release notes",
      config: { url: feedUrl },
      schedule: "*/15 * * * *",
      lastPolledAt: null,
    });
    // The tick enqueues every Source with next_poll_at <= now().
    expect(saved?.nextPollAt.getTime()).toBeLessThanOrEqual(Date.now());
    const due = await db.select({ id: source.id }).from(source).where(lte(source.nextPollAt, new Date()));
    expect(due.map((row) => row.id)).toContain(id);
    expect(saved?.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });

  it("keeps the name the user gave", async () => {
    const { id } = await added(ours, { url: feedUrl, name: "  Our releases " });
    const [saved] = await db.select().from(source).where(eq(source.id, id));
    expect(saved?.name).toBe("Our releases");
  });

  it.each([
    ["isn't a URL", "not a url", /full RSS feed URL/],
    ["isn't http or https", "ftp://feeds.test/news.rss", /full RSS feed URL/],
    ["isn't a feed", "https://feeds.test/page.html", /isn't an RSS or Atom feed/],
    ["answers with an error", "https://feeds.test/gone.rss", /answered 404 Not Found/],
    ["can't be reached", "https://unreachable.test/feed.rss", /couldn't reach unreachable\.test/],
  ])("refuses a URL that %s and saves nothing", async (_case, url, message) => {
    const before = (await sourcesIn(ours)).length;
    const result = await addRssSource(db, selfHosted, ours, { url, name: "", schedule: "*/15 * * * *" });
    expect(result).toEqual({ field: "url", error: expect.stringMatching(message) });
    expect(await sourcesIn(ours)).toHaveLength(before);
  });

  it("refuses a URL that resolves to a blocked address and saves nothing", async () => {
    const config = loadConfig(
      { DATABASE_URL: "postgres://unused", BETTER_AUTH_SECRET: "a".repeat(32), BETTER_AUTH_URL: "http://localhost:3000" },
      () => undefined,
    );
    const lookup = () => Promise.resolve([{ address: "10.0.0.1", family: 4 }]);
    const guarded = { fetch: createEgressFetch(config, { lookup }), mode: "self-hosted" as const };
    const before = (await sourcesIn(ours)).length;

    const result = await addRssSource(db, guarded, ours, {
      url: "http://intranet.test/feed.rss",
      name: "",
      schedule: "*/15 * * * *",
    });

    expect(result).toEqual({ field: "url", error: expect.stringContaining("10.0.0.1") });
    expect(await sourcesIn(ours)).toHaveLength(before);
  });

  it("refuses a schedule the mode doesn't allow, before fetching", async () => {
    let fetched = false;
    const hosted: SourceDeps = { mode: "hosted", fetch: (...args) => ((fetched = true), fakeFetch(...args)) };
    const before = (await sourcesIn(ours)).length;

    const result = await addRssSource(db, hosted, ours, { url: feedUrl, name: "", schedule: "*/5 * * * *" });

    expect(result).toEqual({ field: "schedule", error: expect.stringContaining("15 minutes") });
    expect(fetched).toBe(false);
    expect(await sourcesIn(ours)).toHaveLength(before);
  });

  it("lists only the Workspace's own Sources", async () => {
    const mine = await added(ours, { url: feedUrl, name: "Mine" });
    const other = await added(theirs, { url: feedUrl, name: "Other" });

    const listed = (await listSources(db, ours)).map((row) => row.id);
    expect(listed).toContain(mine.id);
    expect(listed).not.toContain(other.id);
  });

  it("removes a Source with its Items and their Logs", async () => {
    const { id } = await added(ours, { url: feedUrl, name: "Doomed" });
    const [captured] = await db
      .insert(item)
      .values({ workspaceId: ours, sourceId: id, externalId: "one", body: "An entry.", raw: {} })
      .returning();
    await db.insert(itemLog).values({ itemId: captured?.id ?? "", stage: "capture", message: "Captured" });

    expect(await removeSource(db, ours, id)).toBe(true);

    expect(await db.select().from(source).where(eq(source.id, id))).toEqual([]);
    expect(await db.select().from(item).where(eq(item.sourceId, id))).toEqual([]);
    expect(await db.select().from(itemLog).where(eq(itemLog.itemId, captured?.id ?? ""))).toEqual([]);
  });

  it("treats another Workspace's Source, or an id that isn't one, as missing", async () => {
    const other = await added(theirs, { url: feedUrl, name: "Not ours" });

    expect(await removeSource(db, ours, other.id)).toBe(false);
    expect(await removeSource(db, ours, "not-a-uuid")).toBe(false);
    expect(await db.select().from(source).where(eq(source.id, other.id))).toHaveLength(1);
  });
});
