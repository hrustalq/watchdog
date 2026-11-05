import { processItem } from "@watchdog/core";
import { type FakeTurn, fakeLlm } from "@watchdog/core/testing";
import {
  classifier,
  closeDb,
  correction,
  createDb,
  type Db,
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
import { startPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { correctCategories, correctRating } from "./corrections.ts";
import { topPage } from "./feed.ts";

/** The value, which the test expects to be there. */
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}

const encryptionKey = Buffer.alloc(32, 7);
const rated = { summary: "A short summary", reasoning: "It names a product", severity: 2, importance: 3 };

describe("Corrections", () => {
  let db: Db;

  beforeAll(async () => {
    const postgres = await startPostgres();
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

  async function capture(
    seeded: Seeded,
    values: { title?: string; summary?: string; severity?: number; importance?: number } = {},
  ) {
    const [created] = await db
      .insert(item)
      .values({ ...seeded, externalId: crypto.randomUUID(), title: "A post", body: "Body", raw: {}, ...values })
      .returning();
    return present(created).id;
  }

  const addCategories = (itemId: string, ...categories: string[]) =>
    db.insert(itemCategory).values(categories.map((category) => ({ itemId, category })));

  const reload = async (itemId: string) =>
    present(await db.query.item.findFirst({ where: eq(item.id, itemId) }));

  const categoriesOf = async (itemId: string) =>
    (await db.select().from(itemCategory).where(eq(itemCategory.itemId, itemId)))
      .map((row) => row.category)
      .sort();

  const correctionsOf = (workspaceId: string) =>
    db.select().from(correction).where(eq(correction.workspaceId, workspaceId));

  const logOf = async (itemId: string) =>
    (await db.select().from(itemLog).where(eq(itemLog.itemId, itemId)).orderBy(itemLog.id)).filter(
      (row) => row.stage === "correct",
    );

  async function addModel({ workspaceId }: Seeded) {
    await db.insert(modelConfig).values({
      workspaceId,
      providerType: "openai-compatible",
      baseUrl: "https://llm.test/v1",
      modelName: "fake-model",
      supportsStructuredOutput: true,
    });
  }

  /** The fake model answering every call with these turns, as `processItem` takes it. */
  function answering(...turns: FakeTurn[]) {
    const fake = fakeLlm("openai-compatible", [...turns, { json: rated }]);
    return { ...fake, deps: { agent: { fetch: fake.fetch, encryptionKey } } };
  }

  /** Everything the last call to the model was sent. */
  const lastRequest = (fake: { requests: { body: unknown }[] }) =>
    JSON.stringify(present(fake.requests.at(-1)).body);

  describe("of a Rating", () => {
    it("updates the Item, its copies and the Log in one step", async () => {
      const seeded = await seed();
      const itemId = await capture(seeded, { title: "Outage", summary: "It's down", severity: 4, importance: 3 });

      await correctRating(db, seeded.workspaceId, itemId, { severity: 2 });

      const corrected = await reload(itemId);
      expect(corrected).toMatchObject({ severity: 2, importance: 3, topScore: 8, ratedAt: null });
      expect(corrected.ratingCorrectedAt).not.toBeNull();
      expect(corrected.categoriesCorrectedAt).toBeNull();
      const before = { severity: 4, importance: 3 };
      const after = { severity: 2, importance: 3 };
      expect(await correctionsOf(seeded.workspaceId)).toMatchObject([
        { itemId, kind: "rating", itemTitle: "Outage", itemSummary: "It's down", before, after },
      ]);
      expect(await logOf(itemId)).toMatchObject([
        {
          message: "Corrected the Rating from Severity 4, Importance 3 to Severity 2, Importance 3",
          data: { kind: "rating", before, after },
        },
      ]);
    });

    it("moves the Item in Top at once", async () => {
      const seeded = await seed();
      const first = await capture(seeded, { severity: 5, importance: 5 });
      const second = await capture(seeded, { severity: 1, importance: 1 });
      const order = async () => (await topPage(db, seeded.workspaceId)).items.map((row) => row.id);
      expect(await order()).toEqual([first, second]);

      await correctRating(db, seeded.workspaceId, second, { importance: 5, severity: 5 });
      await correctRating(db, seeded.workspaceId, first, { importance: 1 });

      expect(await order()).toEqual([second, first]);
    });

    it("rates an unrated Item with both axes, which then joins Top", async () => {
      const seeded = await seed();
      const itemId = await capture(seeded);

      await correctRating(db, seeded.workspaceId, itemId, { severity: 3, importance: 4 });

      expect(await reload(itemId)).toMatchObject({ severity: 3, importance: 4, topScore: 11 });
      expect(await correctionsOf(seeded.workspaceId)).toMatchObject([
        { before: { severity: null, importance: null }, after: { severity: 3, importance: 4 } },
      ]);
      expect(await logOf(itemId)).toMatchObject([
        { message: "Corrected the Rating from Unrated to Severity 3, Importance 4" },
      ]);
      const top = await topPage(db, seeded.workspaceId);
      expect({ fallback: top.fallback, ids: top.items.map((row) => row.id) }).toEqual({
        fallback: false,
        ids: [itemId],
      });
    });

    it("refuses one axis on an unrated Item, because a Rating has both", async () => {
      const seeded = await seed();
      const itemId = await capture(seeded);

      await correctRating(db, seeded.workspaceId, itemId, { severity: 3 });

      expect(await reload(itemId)).toMatchObject({ severity: null, importance: null, ratingCorrectedAt: null });
      expect(await correctionsOf(seeded.workspaceId)).toEqual([]);
    });

    it("keeps one row with the original before when corrected twice, and logs each step", async () => {
      const seeded = await seed();
      const itemId = await capture(seeded, { title: "Old title", severity: 4, importance: 3 });
      await correctRating(db, seeded.workspaceId, itemId, { severity: 2 });
      const [first] = await correctionsOf(seeded.workspaceId);
      await db.update(item).set({ title: "New title", summary: "Now summarised" }).where(eq(item.id, itemId));

      await correctRating(db, seeded.workspaceId, itemId, { importance: 1 });

      const rows = await correctionsOf(seeded.workspaceId);
      expect(rows).toMatchObject([
        {
          id: present(first).id,
          itemTitle: "New title",
          itemSummary: "Now summarised",
          before: { severity: 4, importance: 3 },
          after: { severity: 2, importance: 1 },
        },
      ]);
      expect(present(rows[0]).createdAt.getTime()).toBeGreaterThan(present(first).createdAt.getTime());
      expect((await logOf(itemId)).map((row) => row.message)).toEqual([
        "Corrected the Rating from Severity 4, Importance 3 to Severity 2, Importance 3",
        "Corrected the Rating from Severity 2, Importance 3 to Severity 2, Importance 1",
      ]);
    });

    it("drops the Correction when the user goes back to the original, and keeps the Item corrected", async () => {
      const seeded = await seed();
      const itemId = await capture(seeded, { severity: 4, importance: 3 });
      await correctRating(db, seeded.workspaceId, itemId, { severity: 2 });

      await correctRating(db, seeded.workspaceId, itemId, { severity: 4 });

      expect(await correctionsOf(seeded.workspaceId)).toEqual([]);
      expect((await reload(itemId)).ratingCorrectedAt).not.toBeNull();
      expect((await logOf(itemId)).map((row) => row.message)).toEqual([
        "Corrected the Rating from Severity 4, Importance 3 to Severity 2, Importance 3",
        "Corrected the Rating from Severity 2, Importance 3 to Severity 4, Importance 3",
      ]);
    });

    it("changes nothing when the level is the one the Item already has", async () => {
      const seeded = await seed();
      const itemId = await capture(seeded, { severity: 4, importance: 3 });

      await correctRating(db, seeded.workspaceId, itemId, { severity: 4 });

      expect((await reload(itemId)).ratingCorrectedAt).toBeNull();
      expect(await correctionsOf(seeded.workspaceId)).toEqual([]);
      expect(await logOf(itemId)).toEqual([]);
    });

    it("refuses another Workspace's Item", async () => {
      const seeded = await seed();
      const itemId = await capture(seeded, { severity: 4, importance: 3 });
      const other = await seed();

      await correctRating(db, other.workspaceId, itemId, { severity: 1 });

      expect(await reload(itemId)).toMatchObject({ severity: 4, ratingCorrectedAt: null });
      expect(await correctionsOf(other.workspaceId)).toEqual([]);
      expect(await correctionsOf(seeded.workspaceId)).toEqual([]);
      expect(await logOf(itemId)).toEqual([]);
    });
  });

  describe("of Categories", () => {
    it("adds a Category, with no Classifier behind it", async () => {
      const seeded = await seed();
      const itemId = await capture(seeded, { title: "Launch", summary: "It launched" });
      await addCategories(itemId, "news");

      await correctCategories(db, seeded.workspaceId, itemId, { add: "competitor" });

      expect(await categoriesOf(itemId)).toEqual(["competitor", "news"]);
      const corrected = await reload(itemId);
      expect(corrected.categoriesCorrectedAt).not.toBeNull();
      expect(corrected.ratingCorrectedAt).toBeNull();
      const before = { categories: ["news"] };
      const after = { categories: ["competitor", "news"] };
      expect(await correctionsOf(seeded.workspaceId)).toMatchObject([
        { itemId, kind: "categories", itemTitle: "Launch", itemSummary: "It launched", before, after },
      ]);
      expect(await logOf(itemId)).toMatchObject([
        {
          message: "Corrected the Categories from news to competitor, news",
          data: { kind: "categories", before, after },
        },
      ]);
    });

    it("removes the last Category, and says so in words", async () => {
      const seeded = await seed();
      const itemId = await capture(seeded);
      await addCategories(itemId, "news");

      await correctCategories(db, seeded.workspaceId, itemId, { remove: "news" });

      expect(await categoriesOf(itemId)).toEqual([]);
      expect(await logOf(itemId)).toMatchObject([{ message: "Corrected the Categories from news to none" }]);
    });

    it("keeps one row with the original before when corrected twice", async () => {
      const seeded = await seed();
      const itemId = await capture(seeded);
      await addCategories(itemId, "news");

      await correctCategories(db, seeded.workspaceId, itemId, { add: "lead" });
      await correctCategories(db, seeded.workspaceId, itemId, { remove: "news" });

      expect(await correctionsOf(seeded.workspaceId)).toMatchObject([
        { before: { categories: ["news"] }, after: { categories: ["lead"] } },
      ]);
    });

    it("drops the Correction when the Categories go back to the original", async () => {
      const seeded = await seed();
      const itemId = await capture(seeded);
      await addCategories(itemId, "news");
      await correctCategories(db, seeded.workspaceId, itemId, { add: "lead" });

      await correctCategories(db, seeded.workspaceId, itemId, { remove: "lead" });

      expect(await correctionsOf(seeded.workspaceId)).toEqual([]);
      expect((await reload(itemId)).categoriesCorrectedAt).not.toBeNull();
    });

    it("keeps a Rating Correction and a Category Correction as separate rows", async () => {
      const seeded = await seed();
      const itemId = await capture(seeded, { severity: 1, importance: 1 });

      await correctRating(db, seeded.workspaceId, itemId, { severity: 5 });
      await correctCategories(db, seeded.workspaceId, itemId, { add: "lead" });

      expect((await correctionsOf(seeded.workspaceId)).map((row) => row.kind).sort()).toEqual([
        "categories",
        "rating",
      ]);
    });

    it.each([
      ["a Category it already has", { add: "news" }],
      ["a Category it doesn't have", { remove: "lead" }],
      ["a blank Category", { add: "   " }],
      ["a Category over the limit", { add: "x".repeat(101) }],
      ["a Category Postgres can't store", { add: "a\u0000b" }],
    ])("changes nothing for %s", async (_name, change) => {
      const seeded = await seed();
      const itemId = await capture(seeded);
      await addCategories(itemId, "news");

      await correctCategories(db, seeded.workspaceId, itemId, change);

      expect(await categoriesOf(itemId)).toEqual(["news"]);
      expect((await reload(itemId)).categoriesCorrectedAt).toBeNull();
      expect(await correctionsOf(seeded.workspaceId)).toEqual([]);
    });

    it("trims what the user typed", async () => {
      const seeded = await seed();
      const itemId = await capture(seeded);

      await correctCategories(db, seeded.workspaceId, itemId, { add: "  lead " });

      expect(await categoriesOf(itemId)).toEqual(["lead"]);
    });

    it("refuses another Workspace's Item", async () => {
      const seeded = await seed();
      const itemId = await capture(seeded);
      await addCategories(itemId, "news");
      const other = await seed();

      await correctCategories(db, other.workspaceId, itemId, { remove: "news" });

      expect(await categoriesOf(itemId)).toEqual(["news"]);
      expect(await correctionsOf(other.workspaceId)).toEqual([]);
    });
  });

  describe("as the Agent sees them", () => {
    it("puts a Correction in the next rated Item's prompt", async () => {
      const seeded = await seed();
      await addModel(seeded);
      const corrected = await capture(seeded, { title: "Corrected post", severity: 1, importance: 1 });
      await correctRating(db, seeded.workspaceId, corrected, { severity: 5 });
      const next = await capture(seeded, { title: "Next post" });
      const fake = answering();

      await processItem(db, next, fake.deps);

      const sent = lastRequest(fake);
      expect(sent).toContain("Corrected post");
      expect(sent).toContain("Next post");
    });

    it("keeps a Correction whose Item is gone, with its copies, in the prompt", async () => {
      const seeded = await seed();
      await addModel(seeded);
      const gone = await capture(seeded, {
        title: "Deleted post",
        summary: "Deleted summary",
        severity: 1,
        importance: 1,
      });
      await correctRating(db, seeded.workspaceId, gone, { severity: 5 });
      await db.delete(item).where(eq(item.id, gone));
      expect(await correctionsOf(seeded.workspaceId)).toMatchObject([
        { itemId: null, itemTitle: "Deleted post", itemSummary: "Deleted summary" },
      ]);
      const next = await capture(seeded, { title: "Next post" });
      const fake = answering();

      await processItem(db, next, fake.deps);

      const sent = lastRequest(fake);
      expect(sent).toContain("Deleted post");
      expect(sent).toContain("Deleted summary");
    });

    it("sends only the 20 most recent", async () => {
      const seeded = await seed();
      await addModel(seeded);
      for (let index = 0; index < 21; index += 1) {
        const title = `Corrected ${String(index).padStart(2, "0")}.`;
        const corrected = await capture(seeded, { title, severity: 1, importance: 1 });
        await correctRating(db, seeded.workspaceId, corrected, { severity: 5 });
      }
      const next = await capture(seeded, { title: "Next post" });
      const fake = answering();

      await processItem(db, next, fake.deps);

      const sent = lastRequest(fake);
      expect(sent).toContain("Corrected 20.");
      expect(sent).toContain("Corrected 01.");
      expect(sent).not.toContain("Corrected 00.");
    });

    it("keeps a Rating Correction made while a retry's call is running", async () => {
      const seeded = await seed();
      await addModel(seeded);
      const itemId = await capture(seeded);
      await processItem(db, itemId, answering({ status: 400 }).deps).catch(() => undefined);
      const fake = answering();
      const during: typeof fake.fetch = async (input, init) => {
        await correctRating(db, seeded.workspaceId, itemId, { severity: 5, importance: 1 });
        return fake.fetch(input, init);
      };

      await processItem(db, itemId, { agent: { fetch: during, encryptionKey } });

      expect(await reload(itemId)).toMatchObject({ severity: 5, importance: 1, summary: rated.summary });
    });

    it("keeps a Category Correction made while a retry's call is running", async () => {
      const seeded = await seed();
      await addModel(seeded);
      await db.insert(classifier).values({
        workspaceId: seeded.workspaceId,
        name: "Sort",
        kind: "agent",
        definition: { classifier: "Sort", prompt: "Sort it", categories: ["agent-said"] },
      });
      const itemId = await capture(seeded);
      await processItem(db, itemId, answering({ status: 400 }).deps).catch(() => undefined);
      const fake = answering({ json: { categories: ["agent-said"] } });
      const during: typeof fake.fetch = async (input, init) => {
        await correctCategories(db, seeded.workspaceId, itemId, { add: "mine" });
        return fake.fetch(input, init);
      };

      await processItem(db, itemId, { agent: { fetch: during, encryptionKey } });

      expect(await categoriesOf(itemId)).toEqual(["mine"]);
    });
  });
});
