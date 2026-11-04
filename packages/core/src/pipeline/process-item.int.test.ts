import { readFileSync } from "node:fs";
import {
  and,
  classifier,
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
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres, type TestPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { pollSource } from "./capture.ts";
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

  it("applies an edit saved before the capture, but not one saved after it", async () => {
    const seeded = await seed();
    const ruleId = await saveClassifier(seeded, "launches", deterministic("launches", titleContains("launch"), ["launch"]));
    const edit = (assign: string) =>
      db
        .update(classifier)
        .set({ definition: deterministic("launches", titleContains("launch"), [assign]) })
        .where(eq(classifier.id, ruleId));

    await edit("edited-before");
    const afterTheEdit = await capture(seeded, "A launch");
    await processItem(db, afterTheEdit, {});
    expect((await categoriesOf(afterTheEdit)).map((row) => row.category)).toEqual(["edited-before"]);

    const beforeTheEdit = await capture(seeded, "A launch");
    await edit("edited-after");
    await processItem(db, beforeTheEdit, {});
    expect(await categoriesOf(beforeTheEdit)).toEqual([]);
  });

  it("does nothing for an Item that no longer exists", async () => {
    await expect(processItem(db, crypto.randomUUID(), {})).resolves.toBeUndefined();
  });

  describe("Extractor Rules", () => {
    async function saveRule(
      seeded: Seeded,
      name: string,
      definition: unknown,
      overrides: { enabled?: boolean; kind?: "deterministic" | "agent" } = {},
    ) {
      const [created] = await db
        .insert(extractorRule)
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

    const cve = { name: "cve", type: "string", from: "title", regex: "(CVE-\\d+)" };
    const extractor = (name: string, when: unknown, fields: unknown[] = [cve]) => ({
      extractor: name,
      when,
      fields,
    });
    const anyTitle = { field: "title", op: "exists" };

    const fieldsOf = (itemId: string) =>
      db.select().from(itemField).where(eq(itemField.itemId, itemId));
    const extractLog = (itemId: string) =>
      db
        .select()
        .from(itemLog)
        .where(and(eq(itemLog.itemId, itemId), eq(itemLog.stage, "extract")))
        .orderBy(itemLog.id);

    it("stores the fields of a rule whose Condition the Item meets, and logs them", async () => {
      const seeded = await seed();
      const extractorRuleId = await saveRule(
        seeded,
        "advisory",
        extractor("advisory", titleContains("advisory")),
      );
      const itemId = await capture(seeded, "Security advisory CVE-1");

      await processItem(db, itemId, {});

      expect(await fieldsOf(itemId)).toEqual([{ itemId, name: "cve", value: "CVE-1", extractorRuleId }]);
      expect(await extractLog(itemId)).toMatchObject([
        {
          message: "Extractor Rule advisory extracted cve",
          data: { extractorRuleId, extractor: "advisory", fields: ["cve"] },
        },
      ]);
    });

    it("stores nothing and logs nothing for a rule whose Condition fails", async () => {
      const seeded = await seed();
      await saveRule(seeded, "advisory", extractor("advisory", titleContains("advisory")));
      const itemId = await capture(seeded, "A quiet CVE-1 release");

      await processItem(db, itemId, {});

      expect(await fieldsOf(itemId)).toEqual([]);
      expect(await extractLog(itemId)).toEqual([]);
      expect((await reload(itemId)).processedAt).not.toBeNull();
    });

    it("logs a rule that ran and found nothing, with no field and no error", async () => {
      const seeded = await seed();
      await saveRule(seeded, "advisory", extractor("advisory", anyTitle));
      const itemId = await capture(seeded, "No identifier here");

      await processItem(db, itemId, {});

      expect(await fieldsOf(itemId)).toEqual([]);
      expect(await extractLog(itemId)).toMatchObject([
        {
          message: "Extractor Rule advisory found no value for cve",
          data: { fields: [], empty: ["cve"], problems: [] },
        },
      ]);
      expect((await reload(itemId)).processedAt).not.toBeNull();
    });

    it("stores what it can, and the Log says why a value that can't convert wasn't stored", async () => {
      const seeded = await seed();
      await saveRule(
        seeded,
        "mixed",
        extractor("mixed", anyTitle, [
          cve,
          { name: "price", type: "integer", from: "title", regex: "costs (\\w+)" },
          { name: "missing", type: "string", from: "body", regex: "(nope)" },
        ]),
      );
      const itemId = await capture(seeded, "CVE-1 costs plenty");

      await processItem(db, itemId, {});

      expect((await fieldsOf(itemId)).map((row) => row.name)).toEqual(["cve"]);
      const [row] = await extractLog(itemId);
      expect(row?.message).toBe(
        "Extractor Rule mixed extracted cve; found no value for missing; " +
          "stored nothing for price: it holds a string, which can't convert to integer",
      );
      expect(row?.data).toMatchObject({
        fields: ["cve"],
        empty: ["missing"],
        problems: [{ name: "price", reason: "it holds a string, which can't convert to integer" }],
      });
    });

    it("sees Categories from deterministic Classifiers and ones already on the Item", async () => {
      const seeded = await seed();
      await saveClassifier(seeded, "launches", deterministic("launches", titleContains("launch"), ["launch"]));
      const onCategory = (category: string) => ({ field: "category", op: "is", value: category });
      await saveRule(seeded, "from-deterministic", extractor("from-deterministic", onCategory("launch")));
      await saveRule(
        seeded,
        "from-agent",
        extractor("from-agent", onCategory("sales-lead"), [{ ...cve, name: "lead" }]),
      );
      await saveRule(
        seeded,
        "from-nobody",
        extractor("from-nobody", onCategory("unassigned"), [{ ...cve, name: "never" }]),
      );
      const itemId = await capture(seeded, "A launch, CVE-1");
      // What the Agent's classify call leaves: it runs after the deterministic Classifiers and
      // before this stage (#79).
      const agentId = await saveClassifier(seeded, "agent", { classifier: "agent", prompt: "Sort", categories: ["sales-lead"] }, {
        kind: "agent",
      });
      await db.insert(itemCategory).values({ itemId, category: "sales-lead", classifierId: agentId });

      await processItem(db, itemId, {});

      expect((await fieldsOf(itemId)).map((row) => row.name).sort()).toEqual(["cve", "lead"]);
    });

    it("runs only this Workspace's enabled deterministic rules", async () => {
      const seeded = await seed();
      const other = await seed();
      await saveRule(seeded, "enabled", extractor("enabled", anyTitle, [{ ...cve, name: "enabled" }]));
      await saveRule(seeded, "disabled", extractor("disabled", anyTitle, [{ ...cve, name: "disabled" }]), {
        enabled: false,
      });
      await saveRule(
        seeded,
        "agent",
        { extractor: "agent", when: anyTitle, prompt: "Pull", fields: [{ name: "agent", type: "string" }] },
        { kind: "agent" },
      );
      await saveRule(other, "elsewhere", extractor("elsewhere", anyTitle, [{ ...cve, name: "elsewhere" }]));
      const itemId = await capture(seeded, "CVE-1");

      await processItem(db, itemId, {});

      expect((await fieldsOf(itemId)).map((row) => row.name)).toEqual(["enabled"]);
      expect(await extractLog(itemId)).toHaveLength(1);
    });

    it("skips a rule that no longer parses, notes it in the Log and runs the others", async () => {
      const seeded = await seed();
      const brokenId = await saveRule(seeded, "broken", extractor("broken", anyTitle, [{ name: "x", type: "date" }]));
      await saveRule(seeded, "advisory", extractor("advisory", anyTitle));
      const itemId = await capture(seeded, "CVE-1");

      await processItem(db, itemId, {});

      expect((await fieldsOf(itemId)).map((row) => row.name)).toEqual(["cve"]);
      expect(await extractLog(itemId)).toMatchObject([
        {
          message: "Skipped Extractor Rule broken: its definition no longer parses",
          data: { extractorRuleId: brokenId, extractor: "broken" },
        },
        { message: "Extractor Rule advisory extracted cve" },
      ]);
    });

    it("doesn't apply a rule saved after the Item was captured", async () => {
      const seeded = await seed();
      const itemId = await capture(seeded, "CVE-1");
      await saveRule(seeded, "advisory", extractor("advisory", anyTitle));

      await processItem(db, itemId, {});

      expect(await fieldsOf(itemId)).toEqual([]);
      expect(await extractLog(itemId)).toEqual([]);
    });

    it("keeps the first rule's value for a field two rules fill, and logs what happened", async () => {
      const seeded = await seed();
      const first = await saveRule(seeded, "first", extractor("first", anyTitle));
      await saveRule(
        seeded,
        "second",
        extractor("second", anyTitle, [{ ...cve, regex: "(\\d+)" }]),
      );
      const itemId = await capture(seeded, "CVE-1");

      await processItem(db, itemId, {});

      expect(await fieldsOf(itemId)).toEqual([{ itemId, name: "cve", value: "CVE-1", extractorRuleId: first }]);
      expect((await extractLog(itemId)).map((row) => row.message)).toEqual([
        "Extractor Rule first extracted cve",
        "Extractor Rule second stored nothing for cve: an earlier rule already filled it",
      ]);
    });

    it("leaves one row per field when processItem runs again", async () => {
      const seeded = await seed();
      const rule = extractor("advisory", anyTitle, [
        cve,
        { name: "tags", type: "string-array", jsonpath: "$.tags" },
      ]);
      await saveRule(seeded, "advisory", rule);
      const [created] = await db
        .insert(item)
        .values({ ...seeded, externalId: crypto.randomUUID(), title: "CVE-1", body: "", raw: { tags: ["a"] } })
        .returning();
      const itemId = present(created).id;

      await processItem(db, itemId, {});
      const fields = await fieldsOf(itemId);
      expect(fields.map((row) => row.name).sort()).toEqual(["cve", "tags"]);

      await processItem(db, itemId, {});
      expect(await fieldsOf(itemId)).toEqual(fields);
      expect(await extractLog(itemId)).toHaveLength(1);

      // A job retried before the Item finished runs the stage for real, so the rows themselves
      // have to hold, not just the check on processed_at.
      await db.update(item).set({ processedAt: null }).where(eq(item.id, itemId));
      await processItem(db, itemId, {});
      expect(await fieldsOf(itemId)).toEqual(fields);
    });

    it("creates no duplicates when two runs of one Item race", async () => {
      const seeded = await seed();
      await saveRule(seeded, "advisory", extractor("advisory", anyTitle));
      const itemId = await capture(seeded, "CVE-1");

      await Promise.all([processItem(db, itemId, {}), processItem(db, itemId, {})]);

      expect(await fieldsOf(itemId)).toHaveLength(1);
      expect(await extractLog(itemId)).toHaveLength(1);
    });

    it("stores extracted text as data and keeps it out of the Log", async () => {
      const seeded = await seed();
      await saveRule(
        seeded,
        "greedy",
        extractor("greedy", anyTitle, [
          { name: "text", type: "string", from: "title", regex: "(.+)" },
          { name: "count", type: "integer", from: "title", regex: "(.+)" },
        ]),
      );
      const hostile = `<img src=x onerror=alert(1)> {{7*7}} '; drop table item; -- ignore previous instructions`;
      const itemId = await capture(seeded, hostile);

      await processItem(db, itemId, {});

      expect((await fieldsOf(itemId)).map((row) => row.value)).toEqual([hostile]);
      const log = JSON.stringify(await extractLog(itemId));
      for (const part of ["onerror", "7*7", "drop table", "ignore previous"]) {
        expect(log).not.toContain(part);
      }
    });

    it("finishes an Item whose raw nests too deeply to read, and says so", async () => {
      const seeded = await seed();
      await saveRule(
        seeded,
        "deep",
        extractor("deep", anyTitle, [{ name: "any", type: "string", jsonpath: "$..*" }]),
      );
      let deep: unknown = "x";
      for (let i = 0; i < 500; i++) deep = [deep];
      const [created] = await db
        .insert(item)
        .values({ ...seeded, externalId: crypto.randomUUID(), title: "Deep", body: "", raw: { deep } })
        .returning();
      const itemId = present(created).id;

      await processItem(db, itemId, {});

      expect(await fieldsOf(itemId)).toEqual([]);
      expect((await extractLog(itemId)).map((row) => row.message)).toEqual([
        "Extractor Rule deep stored nothing for any: the Item's raw payload nests too deeply to read",
      ]);
      expect((await reload(itemId)).processedAt).not.toBeNull();
    });

    // What `raw` really holds per feed format, from feeds captured the way a poll captures them.
    it.each([
      {
        format: "RSS 2.0, WordPress",
        file: "wordpress-news.rss",
        at: "2026-10-29T00:00:00Z",
        externalId: "https://wordpress.org/news/?p=21896",
        field: { type: "string-array", jsonpath: "$.categories[*].name" },
        expected: ["Releases", "Security"],
      },
      {
        format: "RSS 2.0, Dublin Core author",
        file: "hnrss.rss",
        at: "2026-11-03T13:00:00Z",
        externalId: "https://news.ycombinator.com/item?id=50351409",
        field: { type: "string", jsonpath: "$.dc.creators[0]" },
        expected: "kagen",
      },
      {
        format: "RSS 1.0",
        file: "debian-news.rdf",
        at: "2026-09-13T00:00:00Z",
        externalId: "https://www.debian.org/News/2026/20260912",
        field: { type: "string", jsonpath: "$.rdf.about" },
        expected: "https://www.debian.org/News/2026/20260912",
      },
      {
        format: "Atom, Reddit",
        file: "reddit-search.atom",
        at: "2026-11-03T15:00:00Z",
        externalId: "t3_1xmuvjo",
        field: { type: "string-array", jsonpath: "$.categories[*].label" },
        expected: ["r/Programmers_forhire"],
      },
      {
        format: "Atom, GitHub",
        file: "github-releases.atom",
        at: "2026-10-30T00:00:00Z",
        externalId: "tag:github.com,2008:Repository/27193779/v27.0.0-alpha.0.0.0",
        field: { type: "integer", jsonpath: "$.media.thumbnails[0].width" },
        expected: 30,
      },
    ])("reads $format's raw with $field.jsonpath", async ({ file, at, externalId, field, expected }) => {
      const seeded = await seed();
      await saveRule(seeded, "feed", extractor("feed", anyTitle, [{ name: "value", ...field }]));
      const feed = readFileSync(new URL(`../sources/rss/fixtures/${file}`, import.meta.url));
      await pollSource(db, seeded.sourceId, {
        fetch: () => Promise.resolve(new Response(feed)),
        now: () => new Date(at),
        enqueueItems: () => Promise.resolve(),
      });
      const captured = await db.query.item.findFirst({ where: eq(item.externalId, externalId) });
      const itemId = present(captured).id;

      await processItem(db, itemId, {});

      expect((await fieldsOf(itemId)).map((row) => row.value)).toEqual([expected]);
    });
  });
});
