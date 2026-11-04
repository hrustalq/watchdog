import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { migrate as applyMigrations } from "drizzle-orm/node-postgres/migrator";
import { beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Db } from "./client.ts";
import { migrate } from "./migrate.ts";
import { item, itemLog, source, user, workspace } from "./schema/index.ts";
import { startPostgres, type TestPostgres } from "./testing/postgres.ts";

const migrationsDir = path.join(import.meta.dirname, "../migrations");

/** The one row a query returned. */
function only<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined || rows.length > 1) throw new Error(`Expected one row, got ${String(rows.length)}`);
  return row;
}

const newSource = (workspaceId: string) => ({
  workspaceId,
  type: "rss" as const,
  name: "Blog",
  config: { url: "https://example.com/feed.xml" },
  schedule: "*/15 * * * *",
});

/** A user with a Workspace, one RSS Source, and one Item with a capture Log row. */
async function seed(db: Db) {
  const id = crypto.randomUUID();
  const owner = only(
    await db.insert(user).values({ id, name: "Owner", email: `${id}@example.com` }).returning(),
  );
  const ws = only(
    await db.insert(workspace).values({ name: "Workspace", ownerUserId: owner.id }).returning(),
  );
  const src = only(await db.insert(source).values(newSource(ws.id)).returning());
  const captured = only(
    await db
      .insert(item)
      .values({
        workspaceId: ws.id,
        sourceId: src.id,
        externalId: "guid-1",
        title: "First post",
        body: "Hello",
        raw: { guid: "guid-1" },
      })
      .returning(),
  );
  await db
    .insert(itemLog)
    .values({ itemId: captured.id, stage: "capture", message: "Captured from Blog" });
  return { owner, workspace: ws, source: src, item: captured };
}

describe("Source, Item and Log tables", () => {
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

  it("keeps one Item when the same (source_id, external_id) is inserted again", async () => {
    const seeded = await seed(db);

    const again = await db
      .insert(item)
      .values({
        workspaceId: seeded.workspace.id,
        sourceId: seeded.source.id,
        externalId: "guid-1",
        title: "First post, fetched again",
        body: "Hello",
        raw: {},
      })
      .onConflictDoNothing({ target: [item.sourceId, item.externalId] })
      .returning();

    expect(again).toEqual([]);
    const rows = await db.select().from(item).where(eq(item.sourceId, seeded.source.id));
    expect(rows.map((row) => row.title)).toEqual(["First post"]);
  });

  it("refuses an Item whose workspace_id isn't its Source's Workspace", async () => {
    const a = await seed(db);
    const b = await seed(db);

    await expect(
      db.insert(item).values({
        workspaceId: b.workspace.id,
        sourceId: a.source.id,
        externalId: "guid-x",
        body: "",
        raw: {},
      }),
    ).rejects.toMatchObject({ cause: { code: "23503", constraint: "item_source_fk" } });
  });

  it("deleting a user removes their Workspace, Sources, Items and Log rows", async () => {
    const kept = await seed(db);
    const gone = await seed(db);

    await db.delete(user).where(eq(user.id, gone.owner.id));

    expect(await db.select().from(workspace).where(eq(workspace.id, gone.workspace.id))).toEqual([]);
    expect(await db.select().from(source).where(eq(source.id, gone.source.id))).toEqual([]);
    expect(await db.select().from(item).where(eq(item.id, gone.item.id))).toEqual([]);
    expect(await db.select().from(itemLog).where(eq(itemLog.itemId, gone.item.id))).toEqual([]);
    // The other user's rows stay.
    expect(await db.select().from(itemLog).where(eq(itemLog.itemId, kept.item.id))).toHaveLength(1);
  });

  it("serves a keyset Feed page from item_feed_idx without sorting", async () => {
    const seeded = await seed(db);

    // Tiny tables make a seq scan cheapest, so forbid it to see which index the order can use.
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const result = await tx.execute<{ "QUERY PLAN": string }>(sql`
        explain select * from item
        where workspace_id = ${seeded.workspace.id}
          and (captured_at, coalesce(published_at, '-infinity'), id)
            < (${seeded.item.capturedAt.toISOString()}::timestamptz, '-infinity', ${seeded.item.id}::uuid)
        order by captured_at desc, coalesce(published_at, '-infinity') desc, id desc
        limit 50`);
      return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
    });

    expect(plan).toContain("item_feed_idx");
    expect(plan).not.toMatch(/Sort/);
  });

  it.each([
    ["severity", 6],
    ["severity", 0],
    ["importance", 6],
    ["importance", 0],
  ])("refuses a %s of %i", async (axis, value) => {
    const seeded = await seed(db);

    await expect(
      db.update(item).set({ [axis]: value }).where(eq(item.id, seeded.item.id)),
    ).rejects.toMatchObject({ cause: { code: "23514", constraint: `item_${axis}_check` } });
  });

  it("stores a Rating from 1 to 5, and an Item starts unrated", async () => {
    const seeded = await seed(db);
    expect(seeded.item).toMatchObject({ severity: null, importance: null });

    const [low] = await db
      .update(item)
      .set({ severity: 1, importance: 1 })
      .where(eq(item.id, seeded.item.id))
      .returning();
    expect(low).toMatchObject({ severity: 1, importance: 1 });
    const [high] = await db
      .update(item)
      .set({ severity: 5, importance: 5 })
      .where(eq(item.id, seeded.item.id))
      .returning();
    expect(high).toMatchObject({ severity: 5, importance: 5 });
  });

  it("allows the stages through correct in the Log, and nothing else", async () => {
    const seeded = await seed(db);
    const itemId = seeded.item.id;

    await db.insert(itemLog).values(
      (["classify", "extract", "rate", "correct"] as const).map((stage) => ({ itemId, stage, message: stage })),
    );

    const rows = await db.select().from(itemLog).where(eq(itemLog.itemId, itemId));
    expect(rows.map((row) => row.stage).sort()).toEqual(["capture", "classify", "correct", "extract", "rate"]);
    await expect(
      db.execute(sql`insert into item_log (item_id, stage, message) values (${itemId}, 'act', 'Fired')`),
    ).rejects.toMatchObject({ cause: { code: "23514", constraint: "item_log_stage_check" } });
  });

  it("loads a Workspace's Sources with their Items and Logs through the relations", async () => {
    const seeded = await seed(db);

    const loaded = await db.query.workspace.findFirst({
      where: eq(workspace.id, seeded.workspace.id),
      with: { sources: { with: { items: { with: { log: true } } } } },
    });

    expect(loaded?.sources[0]?.items[0]?.log[0]?.message).toBe("Captured from Blog");
  });

  it("applies migration 0003 on a database at 0002 and keeps its Workspaces", async () => {
    await db.execute(sql`create database at_0002`);
    const url = new URL(postgres.url);
    url.pathname = "/at_0002";
    // A copy of migrations/ whose journal stops at 0002, to build a database as it stood then.
    const migrationsAt0002 = await mkdtemp(path.join(tmpdir(), "watchdog-migrations-"));
    try {
      await cp(migrationsDir, migrationsAt0002, { recursive: true });
      const journalPath = path.join(migrationsAt0002, "meta/_journal.json");
      const firstThree = (key: string, value: unknown): unknown =>
        key === "entries" && Array.isArray(value) ? value.slice(0, 3) : value;
      const journal = await readFile(journalPath, "utf8");
      await writeFile(journalPath, JSON.stringify(JSON.parse(journal, firstThree)));

      const old = createDb(url.href);
      try {
        await applyMigrations(old, { migrationsFolder: migrationsAt0002 });
        await old.execute(sql`insert into "user" (id, name, email) values ('u', 'O', 'o@example.com')`);
        await old.execute(sql`insert into workspace (name, owner_user_id) values ('Workspace', 'u')`);
      } finally {
        await closeDb(old);
      }
    } finally {
      await rm(migrationsAt0002, { recursive: true, force: true });
    }

    await migrate(url.href);

    const upgraded = createDb(url.href);
    try {
      const ws = only(await upgraded.select().from(workspace));
      const src = only(await upgraded.insert(source).values(newSource(ws.id)).returning());
      expect(src.nextPollAt).toBeInstanceOf(Date);
    } finally {
      await closeDb(upgraded);
    }
  }, 60_000);
});
