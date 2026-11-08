import { eq, lte, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Db } from "./client.ts";
import { migrate } from "./migrate.ts";
import { destination, healthAlertDestination, source } from "./schema/index.ts";
import { migrateFirst, startPostgres, type TestPostgres } from "./testing/postgres.ts";
import { only, twoWorkspaces } from "./testing/seed.ts";

const rss = (workspaceId: string, name: string, url: string) => ({
  workspaceId,
  type: "rss" as const,
  name,
  config: { url },
  schedule: "*/15 * * * *",
});

/** Postgres's refusal through the named constraint, and no other. */
const refusal = (constraint: string) => ({ cause: { constraint } });

const keyed = "source_workspace_id_type_dedup_key_key";
const scheduleCheck = "source_schedule_check";

describe("source", () => {
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

  it("holds one Source per feed URL in a Workspace, and lets another Workspace have it too", async () => {
    const [a = "", b = ""] = await twoWorkspaces(db);
    await db.insert(source).values(rss(a, "First", "https://example.com/feed.xml"));

    await expect(db.insert(source).values(rss(a, "Again", "https://example.com/feed.xml"))).rejects.toThrow();
    await db.insert(source).values(rss(b, "Theirs", "https://example.com/feed.xml"));

    const urls = await db.execute<{ workspace_id: string }>(
      sql`select workspace_id from source where config->>'url' = 'https://example.com/feed.xml'`,
    );
    expect(urls.rows.map((row) => row.workspace_id).sort()).toEqual([a, b].sort());
  });

  it("holds a feed URL too long for a btree entry", async () => {
    const [a = ""] = await twoWorkspaces(db);
    // Random hex compresses poorly, so the stored text stays over btree's ~2.7 KB entry limit.
    const query = Array.from({ length: 200 }, () => crypto.randomUUID()).join("");
    const url = `https://example.com/feed.xml?${query}`;

    await db.insert(source).values(rss(a, "Long", url));

    await expect(db.insert(source).values(rss(a, "Long again", url))).rejects.toThrow();
  });

  it("holds one Source per type's key, and any number of inboxes or unbound bot Sources", async () => {
    const [a = ""] = await twoWorkspaces(db);
    const scheduled = { workspaceId: a, name: "S", schedule: "*/15 * * * *" };
    const unscheduled = { workspaceId: a, name: "E", schedule: null, nextPollAt: null };
    const twice = async (first: typeof source.$inferInsert, again: typeof source.$inferInsert) => {
      await db.insert(source).values(first);
      await expect(db.insert(source).values(again)).rejects.toMatchObject(refusal(keyed));
    };

    // GitHub names are case-insensitive.
    await twice(
      { ...scheduled, type: "github", config: { kind: "releases", repo: "Acme/Widget" } },
      { ...scheduled, type: "github", config: { kind: "releases", repo: "acme/widget" } },
    );
    await db.insert(source).values({ ...scheduled, type: "github", config: { kind: "issues", repo: "acme/widget" } });
    await twice(
      { ...scheduled, type: "github", config: { kind: "mentions", term: "watchdog", within: "org:acme" } },
      { ...scheduled, type: "github", config: { kind: "mentions", term: " watchdog ", within: "org:acme" } },
    );
    await db.insert(source).values({ ...scheduled, type: "github", config: { kind: "mentions", term: "watchdog" } });

    const page = { url: "https://example.com/pricing", ignore: [], render: "static" as const };
    await twice(
      { ...scheduled, type: "website", config: { ...page, region: "#price" } },
      { ...scheduled, type: "website", config: { ...page, region: " #price " } },
    );
    await twice(
      { ...scheduled, type: "website", config: page },
      { ...scheduled, type: "website", config: { ...page, region: "" } },
    );

    // A chat is watched once, whichever way.
    await twice(
      { ...unscheduled, type: "telegram", config: { via: "bot", chatId: -1001, title: "Group" } },
      { ...unscheduled, type: "telegram", config: { via: "session", chatId: -1001, title: "Group" } },
    );
    await db.insert(source).values([
      { ...unscheduled, type: "telegram", config: { via: "bot" } },
      { ...unscheduled, type: "telegram", config: { via: "bot" } },
      { ...unscheduled, type: "webhook", config: {} },
      { ...unscheduled, type: "webhook", config: {} },
    ]);
  });

  it("requires a schedule of Schedule Sources only", async () => {
    const [a = ""] = await twoWorkspaces(db);
    const inbox = { workspaceId: a, type: "webhook" as const, name: "Inbox", config: {} };

    const noSchedule = { ...rss(a, "No schedule", "https://example.com/a.xml"), schedule: null };
    await expect(db.insert(source).values(noSchedule)).rejects.toMatchObject(refusal(scheduleCheck));
    const neverDue = { ...rss(a, "Never due", "https://example.com/b.xml"), nextPollAt: null };
    await expect(db.insert(source).values(neverDue)).rejects.toMatchObject(refusal(scheduleCheck));
    // Never polled, so the tick must not find it due.
    await expect(db.insert(source).values(inbox)).rejects.toMatchObject(refusal(scheduleCheck));
    const scheduledInbox = { ...inbox, schedule: "*/15 * * * *", nextPollAt: null };
    await expect(db.insert(source).values(scheduledInbox)).rejects.toMatchObject(refusal(scheduleCheck));

    const saved = only(await db.insert(source).values({ ...inbox, nextPollAt: null }).returning());
    expect(saved).toMatchObject({ schedule: null, nextPollAt: null, health: "ok", consecutiveFailures: 0 });
  });

  it("keeps Health to its three states, and an Inbox token hash to one Source", async () => {
    const [a = ""] = await twoWorkspaces(db);
    const inbox = { workspaceId: a, type: "webhook" as const, name: "Inbox", config: {} };
    const unscheduled = { ...inbox, schedule: null, nextPollAt: null };

    const broken = sql`insert into source (workspace_id, type, name, config, next_poll_at, health)
      values (${a}, 'webhook', 'Bad', '{}', null, 'broken')`;
    await expect(db.execute(broken)).rejects.toMatchObject(refusal("source_health_check"));
    await db.insert(source).values({ ...unscheduled, inboxTokenHash: "hash" });
    await expect(db.insert(source).values({ ...unscheduled, inboxTokenHash: "hash" })).rejects.toMatchObject(
      refusal("source_inbox_token_hash_key"),
    );
  });

  it("drops a deleted Destination from the Health alerts setting", async () => {
    const [a = ""] = await twoWorkspaces(db);
    const target = only(
      await db.insert(destination).values({ workspaceId: a, type: "email", name: "Me", config: {} }).returning(),
    );
    await db.insert(healthAlertDestination).values({ workspaceId: a, destinationId: target.id });

    await db.delete(destination).where(eq(destination.id, target.id));

    expect(await db.select().from(healthAlertDestination).where(eq(healthAlertDestination.workspaceId, a))).toEqual([]);
  });

  it("applies migration 0015 to a database holding M3 Sources, keying each by its URL", async () => {
    await db.execute(sql`create database at_0014`);
    const url = new URL(postgres.url);
    url.pathname = "/at_0014";
    await migrateFirst(url.href, 15);
    const old = createDb(url.href);
    try {
      // Raw SQL: the Drizzle table has columns a database at 0014 doesn't.
      await old.execute(sql`insert into "user" (id, name, email) values ('a', 'A', 'a@example.com')`);
      await old.execute(sql`
        with ws as (insert into workspace (name, owner_user_id) values ('A', 'a') returning id)
        insert into source (workspace_id, type, name, config, schedule)
        select id, 'rss', 'Blog', '{"url": "https://example.com/feed.xml"}', '*/15 * * * *' from ws`);
    } finally {
      await closeDb(old);
    }

    await migrate(url.href);

    const upgraded = createDb(url.href);
    try {
      const blog = only(await upgraded.select().from(source));
      expect(blog).toMatchObject({ dedupKey: "https://example.com/feed.xml", health: "ok", consecutiveFailures: 0 });
      // The scheduler's query still finds it due.
      const due = await upgraded.select({ id: source.id }).from(source).where(lte(source.nextPollAt, new Date()));
      expect(due).toEqual([{ id: blog.id }]);
      const again = rss(blog.workspaceId, "Again", "https://example.com/feed.xml");
      await expect(upgraded.insert(source).values(again)).rejects.toMatchObject(refusal(keyed));
    } finally {
      await closeDb(upgraded);
    }
  }, 60_000);

  it("applies migration 0005 to a database with duplicate Sources, keeping the oldest copy", async () => {
    await db.execute(sql`create database at_0004`);
    const url = new URL(postgres.url);
    url.pathname = "/at_0004";
    await migrateFirst(url.href, 5);
    let oldest: string | undefined;
    const old = createDb(url.href);
    try {
      // Raw SQL: the Drizzle table has columns a database at 0004 doesn't.
      await old.execute(sql`insert into "user" (id, name, email) values ('a', 'A', 'a@example.com'), ('b', 'B', 'b@example.com')`);
      const { rows } = await old.execute<{ id: string }>(
        sql`insert into workspace (name, owner_user_id) values ('A', 'a'), ('B', 'b') returning id`,
      );
      const [a = "", b = ""] = rows.map((row) => row.id);
      const feed = "https://example.com/feed.xml";
      const insert = async (workspaceId: string, name: string, feedUrl: string, createdAt = "2026-04-01") => {
        const { rows: inserted } = await old.execute<{ id: string }>(sql`
          insert into source (workspace_id, type, name, config, schedule, created_at)
          values (${workspaceId}, 'rss', ${name}, ${JSON.stringify({ url: feedUrl })}, '*/15 * * * *', ${createdAt})
          returning id`);
        return inserted[0]?.id;
      };
      oldest = await insert(a, "Oldest", feed, "2026-01-01");
      await insert(a, "Newer", feed, "2026-02-01");
      await insert(a, "Newest", feed, "2026-03-01");
      await insert(a, "Other feed", "https://example.com/other.xml");
      await insert(b, "Theirs", feed);
    } finally {
      await closeDb(old);
    }

    await migrate(url.href);

    const upgraded = createDb(url.href);
    try {
      const names = await upgraded.select({ id: source.id, name: source.name }).from(source);
      expect(names.map((row) => row.name).sort()).toEqual(["Oldest", "Other feed", "Theirs"]);
      expect(names.find((row) => row.name === "Oldest")?.id).toBe(oldest);
    } finally {
      await closeDb(upgraded);
    }
  }, 60_000);
});
