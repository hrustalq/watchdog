import {
  and,
  classifier,
  closeDb,
  createDb,
  type Db,
  eq,
  item,
  itemCategory,
  itemLog,
  migrate,
  source,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres, type TestPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { processItem } from "./process-item.ts";

/** The value, which the test expects to be there. */
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}

const titleContains = (value: string) => ({ field: "title", op: "contains", value });

describe("processItem", () => {
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

  /** A new Workspace with one RSS Source. */
  async function seed() {
    const id = crypto.randomUUID();
    await db.insert(user).values({ id, name: "Owner", email: `${id}@example.com` });
    const [ws] = await db.insert(workspace).values({ name: "Workspace", ownerUserId: id }).returning();
    const workspaceId = present(ws).id;
    const [src] = await db
      .insert(source)
      .values({
        workspaceId,
        type: "rss",
        name: "Blog",
        config: { url: "https://feeds.test/feed.rss" },
        schedule: "*/15 * * * *",
      })
      .returning();
    return { workspaceId, sourceId: present(src).id };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  async function capture(seeded: Seeded, title: string, isBackfill = false) {
    const [created] = await db
      .insert(item)
      .values({ ...seeded, externalId: crypto.randomUUID(), title, body: "Body", raw: {}, isBackfill })
      .returning();
    return present(created).id;
  }

  async function saveClassifier(
    seeded: Seeded,
    name: string,
    definition: unknown,
    overrides: { enabled?: boolean; kind?: "deterministic" | "agent" } = {},
  ) {
    const [created] = await db
      .insert(classifier)
      .values({
        workspaceId: seeded.workspaceId,
        name,
        kind: "deterministic",
        definition,
        ...overrides,
      })
      .returning();
    return present(created).id;
  }

  const deterministic = (name: string, when: unknown, assign: string[]) => ({
    classifier: name,
    when,
    assign,
  });

  const categoriesOf = (itemId: string) =>
    db.select().from(itemCategory).where(eq(itemCategory.itemId, itemId));
  const classifyLog = (itemId: string) =>
    db
      .select()
      .from(itemLog)
      .where(and(eq(itemLog.itemId, itemId), eq(itemLog.stage, "classify")))
      .orderBy(itemLog.id);
  const reload = async (itemId: string) =>
    present(await db.query.item.findFirst({ where: eq(item.id, itemId) }));

  it("assigns a matching Classifier's Categories, logs them and finishes the Item", async () => {
    const seeded = await seed();
    const classifierId = await saveClassifier(
      seeded,
      "launches",
      deterministic("launches", titleContains("launch"), ["competitor-launch", "news"]),
    );
    const itemId = await capture(seeded, "Acme launches a parser");
    const finished = new Date("2026-11-04T12:00:00Z");

    await processItem(db, itemId, { now: () => finished });

    expect(await categoriesOf(itemId)).toEqual(
      expect.arrayContaining([
        { itemId, category: "competitor-launch", classifierId },
        { itemId, category: "news", classifierId },
      ]),
    );
    expect(await classifyLog(itemId)).toMatchObject([
      {
        message: "Classifier launches assigned competitor-launch, news",
        data: {
          classifierId,
          classifier: "launches",
          categories: ["competitor-launch", "news"],
        },
      },
    ]);
    expect((await reload(itemId)).processedAt).toEqual(finished);
  });

  it("adds no Category or Log row for a Classifier that doesn't match, and still finishes", async () => {
    const seeded = await seed();
    await saveClassifier(seeded, "launches", deterministic("launches", titleContains("launch"), ["launch"]));
    const itemId = await capture(seeded, "A quiet maintenance release");

    await processItem(db, itemId, {});

    expect(await categoriesOf(itemId)).toEqual([]);
    expect(await classifyLog(itemId)).toEqual([]);
    expect((await reload(itemId)).processedAt).not.toBeNull();
  });

  it("tests the Source's type, not just the Item's own columns", async () => {
    const seeded = await seed();
    const when = { field: "source.type", op: "is", value: "rss" };
    await saveClassifier(seeded, "from-rss", deterministic("from-rss", when, ["feed"]));
    const itemId = await capture(seeded, "Anything");

    await processItem(db, itemId, {});

    expect((await categoriesOf(itemId)).map((row) => row.category)).toEqual(["feed"]);
  });

  it("classifies a Backfill Item like any other", async () => {
    const seeded = await seed();
    await saveClassifier(seeded, "launches", deterministic("launches", titleContains("launch"), ["launch"]));
    const itemId = await capture(seeded, "An old launch", true);

    await processItem(db, itemId, {});

    expect((await categoriesOf(itemId)).map((row) => row.category)).toEqual(["launch"]);
  });

  it("runs only this Workspace's enabled deterministic Classifiers", async () => {
    const seeded = await seed();
    const other = await seed();
    const rule = (name: string) => deterministic(name, titleContains("launch"), [name]);
    await saveClassifier(seeded, "enabled", rule("enabled"));
    await saveClassifier(seeded, "disabled", rule("disabled"), { enabled: false });
    await saveClassifier(seeded, "agent", { classifier: "agent", prompt: "Sort", categories: ["agent"] }, {
      kind: "agent",
    });
    await saveClassifier(other, "elsewhere", rule("elsewhere"));
    const itemId = await capture(seeded, "A launch");

    await processItem(db, itemId, {});

    expect((await categoriesOf(itemId)).map((row) => row.category)).toEqual(["enabled"]);
    expect(await classifyLog(itemId)).toHaveLength(1);
  });

  it("skips a rule that no longer parses, notes it in the Log and runs the others", async () => {
    const seeded = await seed();
    const brokenId = await saveClassifier(seeded, "broken", {
      classifier: "broken",
      when: { field: "title", op: "matches", value: "(unclosed" },
      assign: ["never"],
    });
    await saveClassifier(seeded, "launches", deterministic("launches", titleContains("launch"), ["launch"]));
    const itemId = await capture(seeded, "A launch");

    await processItem(db, itemId, {});

    expect((await categoriesOf(itemId)).map((row) => row.category)).toEqual(["launch"]);
    expect(await classifyLog(itemId)).toMatchObject([
      {
        message: "Skipped Classifier broken: its definition no longer parses",
        data: { classifierId: brokenId, classifier: "broken" },
      },
      { message: "Classifier launches assigned launch" },
    ]);
    expect((await reload(itemId)).processedAt).not.toBeNull();
  });

  it("keeps one row for a Category two Classifiers assign, naming the first, and logs both", async () => {
    const seeded = await seed();
    const first = await saveClassifier(seeded, "first", deterministic("first", titleContains("launch"), ["launch"]));
    await saveClassifier(seeded, "second", deterministic("second", titleContains("launch"), ["launch", "launch"]));
    const itemId = await capture(seeded, "A launch");

    await processItem(db, itemId, {});

    expect(await categoriesOf(itemId)).toEqual([{ itemId, category: "launch", classifierId: first }]);
    expect((await classifyLog(itemId)).map((row) => row.message)).toEqual([
      "Classifier first assigned launch",
      "Classifier second assigned launch",
    ]);
  });

  it("changes nothing when run again", async () => {
    const seeded = await seed();
    await saveClassifier(seeded, "launches", deterministic("launches", titleContains("launch"), ["launch"]));
    await saveClassifier(seeded, "broken", { classifier: "broken" });
    const itemId = await capture(seeded, "A launch");
    const finished = new Date("2026-11-04T12:00:00Z");

    await processItem(db, itemId, { now: () => finished });
    const categories = await categoriesOf(itemId);
    const log = await classifyLog(itemId);
    expect(log).toHaveLength(2);

    await processItem(db, itemId, { now: () => new Date("2026-11-05T12:00:00Z") });

    expect(await categoriesOf(itemId)).toEqual(categories);
    expect(await classifyLog(itemId)).toEqual(log);
    expect((await reload(itemId)).processedAt).toEqual(finished);
  });

  it("creates no duplicates when two runs of one Item race", async () => {
    const seeded = await seed();
    await saveClassifier(seeded, "launches", deterministic("launches", titleContains("launch"), ["launch"]));
    const itemId = await capture(seeded, "A launch");

    await Promise.all([processItem(db, itemId, {}), processItem(db, itemId, {})]);

    expect(await categoriesOf(itemId)).toHaveLength(1);
    expect(await classifyLog(itemId)).toHaveLength(1);
  });

  it("doesn't apply a rule saved after the Item was captured", async () => {
    const seeded = await seed();
    const itemId = await capture(seeded, "A launch");
    await saveClassifier(seeded, "launches", deterministic("launches", titleContains("launch"), ["launch"]));

    await processItem(db, itemId, {});

    expect(await categoriesOf(itemId)).toEqual([]);
    expect(await classifyLog(itemId)).toEqual([]);
    expect((await reload(itemId)).processedAt).not.toBeNull();
  });

  it("does nothing for an Item that no longer exists", async () => {
    await expect(processItem(db, crypto.randomUUID(), {})).resolves.toBeUndefined();
  });
});
