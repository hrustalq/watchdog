import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Db } from "./client.ts";
import { migrate } from "./migrate.ts";
import { source, user, workspace } from "./schema/index.ts";
import { migrateFirst, startPostgres, type TestPostgres } from "./testing/postgres.ts";

const rss = (workspaceId: string, name: string, url: string) => ({
  workspaceId,
  type: "rss" as const,
  name,
  config: { url },
  schedule: "*/15 * * * *",
});

/** Two Workspaces, with their ids. */
async function twoWorkspaces(db: Db) {
  const suffix = crypto.randomUUID();
  await db.insert(user).values([
    { id: `a-${suffix}`, name: "A", email: `a-${suffix}@example.com` },
    { id: `b-${suffix}`, name: "B", email: `b-${suffix}@example.com` },
  ]);
  const rows = await db
    .insert(workspace)
    .values([
      { name: "A", ownerUserId: `a-${suffix}` },
      { name: "B", ownerUserId: `b-${suffix}` },
    ])
    .returning({ id: workspace.id });
  return rows.map((row) => row.id);
}

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

  it("applies migration 0005 to a database with duplicate Sources, keeping the oldest copy", async () => {
    await db.execute(sql`create database at_0004`);
    const url = new URL(postgres.url);
    url.pathname = "/at_0004";
    await migrateFirst(url.href, 5);
    let oldest: string | undefined;
    const old = createDb(url.href);
    try {
      const [a = "", b = ""] = await twoWorkspaces(old);
      const feed = "https://example.com/feed.xml";
      const [first] = await old
        .insert(source)
        .values({ ...rss(a, "Oldest", feed), createdAt: new Date("2026-01-01T00:00:00Z") })
        .returning({ id: source.id });
      oldest = first?.id;
      await old.insert(source).values([
        { ...rss(a, "Newer", feed), createdAt: new Date("2026-02-01T00:00:00Z") },
        { ...rss(a, "Newest", feed), createdAt: new Date("2026-03-01T00:00:00Z") },
        rss(a, "Other feed", "https://example.com/other.xml"),
        rss(b, "Theirs", feed),
      ]);
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
