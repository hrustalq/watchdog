import {
  agentCall,
  closeDb,
  createDb,
  type Db,
  eq,
  extractorRule,
  item,
  itemField,
  itemLog,
  migrate,
  modelConfig,
  source,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres, type TestPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { type FakeTurn, fakeLlm } from "../agent/fake-llm.ts";
import { runExtractorRuleByHand } from "./manual-run.ts";

/** The value, which the test expects to be there. */
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}

const encryptionKey = Buffer.alloc(32, 7);
/** For a run with no call to make: the fake model throws on any request. */
const noCalls = { fetch: fakeLlm("openai-compatible", []).fetch, encryptionKey };

/** A Condition no test Item meets. */
const neverMet = { field: "title", op: "contains", value: "not in any title" };

const fromTitle = (name: string, regex = "(CVE-\\d+)") => ({ name, type: "string", from: "title", regex });

describe("runExtractorRuleByHand", () => {
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

  /** A new Workspace with one RSS Source and one Item titled "Fixes CVE-1". */
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
    const sourceId = present(src).id;
    const [created] = await db
      .insert(item)
      .values({
        workspaceId,
        sourceId,
        externalId: "1",
        title: "Fixes CVE-1",
        body: "Body",
        raw: { count: "many" },
        processedAt: new Date(),
      })
      .returning();
    return { workspaceId, itemId: present(created).id };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  async function saveRule(seeded: Seeded, name: string, fields: unknown[], when: unknown = neverMet) {
    const [created] = await db
      .insert(extractorRule)
      .values({
        workspaceId: seeded.workspaceId,
        name,
        kind: "deterministic",
        definition: { extractor: name, when, fields },
      })
      .returning();
    return present(created).id;
  }

  async function saveAgentRule(seeded: Seeded, name: string, fields: unknown[]) {
    const definition = { extractor: name, when: neverMet, prompt: `Find ${name}`, fields };
    const [created] = await db
      .insert(extractorRule)
      .values({ workspaceId: seeded.workspaceId, name, kind: "agent", definition })
      .returning();
    return present(created).id;
  }

  const addModel = ({ workspaceId }: Seeded) =>
    db.insert(modelConfig).values({
      workspaceId,
      providerType: "openai-compatible",
      baseUrl: "https://llm.test/v1",
      modelName: "fake-model",
      supportsStructuredOutput: true,
    });

  /** The fake model answering with these turns, and throwing on any request after them. */
  function answering(...turns: FakeTurn[]) {
    const fake = fakeLlm("openai-compatible", turns);
    return { ...fake, deps: { fetch: fake.fetch, encryptionKey } };
  }

  const callsOf = ({ itemId }: Seeded) => db.select().from(agentCall).where(eq(agentCall.itemId, itemId));

  const run = (seeded: Seeded, ruleId: string, deps = noCalls) =>
    runExtractorRuleByHand(db, { ...seeded, ruleId }, deps);

  const fieldsOf = ({ itemId }: Seeded) =>
    db
      .select({ name: itemField.name, value: itemField.value, ruleId: itemField.extractorRuleId })
      .from(itemField)
      .where(eq(itemField.itemId, itemId))
      .orderBy(itemField.name);

  const logOf = ({ itemId }: Seeded) =>
    db.select().from(itemLog).where(eq(itemLog.itemId, itemId)).orderBy(itemLog.id);

  it("runs a deterministic rule whose Condition fails, and logs the run as manual", async () => {
    const seeded = await seed();
    const ruleId = await saveRule(seeded, "CVEs", [fromTitle("cve")]);

    const runId = await run(seeded, ruleId);

    expect(await fieldsOf(seeded)).toEqual([{ name: "cve", value: "CVE-1", ruleId }]);
    const [row] = await logOf(seeded);
    expect(row).toMatchObject({
      id: runId,
      stage: "extract",
      message: "Manual run: Extractor Rule CVEs extracted cve",
      data: { manual: true, extractorRuleId: ruleId, fields: ["cve"] },
    });
  });

  it("reads a CSS field from a website Item's page HTML, and says when an Item has none", async () => {
    const seeded = await seed();
    const ruleId = await saveRule(seeded, "pricing", [{ name: "price", type: "integer", css: ".price" }]);
    await db.update(item).set({ raw: { text: "", html: '<p class="price">29</p>' } }).where(eq(item.id, seeded.itemId));

    await run(seeded, ruleId);
    expect(await fieldsOf(seeded)).toEqual([]);

    const [row] = await db.select({ sourceId: item.sourceId }).from(item).where(eq(item.id, seeded.itemId));
    await db.update(source).set({ type: "website" }).where(eq(source.id, present(row).sourceId));
    await run(seeded, ruleId);

    expect(await fieldsOf(seeded)).toEqual([{ name: "price", value: 29, ruleId }]);
    expect((await logOf(seeded)).map((logged) => logged.message)).toEqual([
      "Manual run: Extractor Rule pricing stored nothing for price: no page HTML on this Item",
      "Manual run: Extractor Rule pricing extracted price",
    ]);
  });

  it("replaces the rule's earlier values, and logs every run", async () => {
    const seeded = await seed();
    const ruleId = await saveRule(seeded, "CVEs", [fromTitle("cve"), fromTitle("old", "(nothing)")]);
    await db.insert(itemField).values([
      { itemId: seeded.itemId, name: "cve", value: "stale", extractorRuleId: ruleId },
      { itemId: seeded.itemId, name: "old", value: "stale", extractorRuleId: ruleId },
    ]);

    await run(seeded, ruleId);
    await run(seeded, ruleId);

    expect(await fieldsOf(seeded)).toEqual([{ name: "cve", value: "CVE-1", ruleId }]);
    expect((await logOf(seeded)).map((row) => row.message)).toEqual([
      "Manual run: Extractor Rule CVEs extracted cve; found no value for old",
      "Manual run: Extractor Rule CVEs extracted cve; found no value for old",
    ]);
  });

  it("leaves a field another rule filled, and says so", async () => {
    const seeded = await seed();
    const otherId = await saveRule(seeded, "Other", [fromTitle("cve", "(Fixes)")]);
    const ruleId = await saveRule(seeded, "CVEs", [fromTitle("cve")]);
    await run(seeded, otherId);

    await run(seeded, ruleId);

    expect(await fieldsOf(seeded)).toEqual([{ name: "cve", value: "Fixes", ruleId: otherId }]);
    expect((await logOf(seeded)).at(-1)?.message).toBe(
      "Manual run: Extractor Rule CVEs stored nothing for cve: another rule already filled it",
    );
  });

  it("keeps a field's earlier value when this run couldn't store a new one", async () => {
    const seeded = await seed();
    const ruleId = await saveRule(seeded, "Counts", [{ name: "count", type: "integer", jsonpath: "$.count" }]);
    await db.insert(itemField).values({ itemId: seeded.itemId, name: "count", value: 7, extractorRuleId: ruleId });

    await run(seeded, ruleId);

    expect(await fieldsOf(seeded)).toEqual([{ name: "count", value: 7, ruleId }]);
    expect((await logOf(seeded)).at(-1)?.message).toBe(
      "Manual run: Extractor Rule Counts stored nothing for count: it holds a string, which can't convert to integer",
    );
  });

  it("takes over a field whose rule was deleted when it finds a value, and otherwise leaves it", async () => {
    const seeded = await seed();
    const ruleId = await saveRule(seeded, "CVEs", [fromTitle("cve"), fromTitle("empty", "(nothing)")]);
    await db.insert(itemField).values([
      { itemId: seeded.itemId, name: "cve", value: "stale" },
      { itemId: seeded.itemId, name: "empty", value: "kept" },
    ]);

    await run(seeded, ruleId);

    expect(await fieldsOf(seeded)).toEqual([
      { name: "cve", value: "CVE-1", ruleId },
      { name: "empty", value: "kept", ruleId: null },
    ]);
  });

  it("runs a disabled rule, and one saved after the Item was captured", async () => {
    const seeded = await seed();
    const ruleId = await saveRule(seeded, "CVEs", [fromTitle("cve")]);
    await db
      .update(extractorRule)
      .set({ enabled: false, updatedAt: new Date("2999-01-01T00:00:00Z") })
      .where(eq(extractorRule.id, ruleId));

    await run(seeded, ruleId);

    expect(await fieldsOf(seeded)).toEqual([{ name: "cve", value: "CVE-1", ruleId }]);
  });

  it("makes one metered call for an Agent-backed rule's fields, and leaves the Rating alone", async () => {
    const seeded = await seed();
    const ruleId = await saveAgentRule(seeded, "Plans", [{ name: "plan", type: "string" }]);
    await addModel(seeded);
    await db
      .update(item)
      .set({ severity: 4, importance: 5, summary: "Kept" })
      .where(eq(item.id, seeded.itemId));
    const fake = answering({ json: { field_plan: "Pro" } });

    const runId = await run(seeded, ruleId, fake.deps);

    expect(await fieldsOf(seeded)).toEqual([{ name: "plan", value: "Pro", ruleId }]);
    expect(await callsOf(seeded)).toMatchObject([{ purpose: "extract-rate", attempt: 1, status: "ok" }]);
    const after = await db.query.item.findFirst({ where: eq(item.id, seeded.itemId) });
    expect(after).toMatchObject({ severity: 4, importance: 5, summary: "Kept", ratedAt: null });
    const [row] = await logOf(seeded);
    expect(row).toMatchObject({
      id: runId,
      stage: "extract",
      message: "Manual run: Extractor Rule Plans extracted plan",
      data: { manual: true, fields: ["plan"] },
    });

    const sent = JSON.stringify(present(fake.requests[0]).body);
    expect(sent).toContain("Find Plans");
    expect(sent).toContain("field_plan");
    expect(sent).not.toContain("severity");
    expect(sent).not.toContain("summary");
  });

  it("runs an Agent-backed rule on an Item captured before the Workspace had a model", async () => {
    const seeded = await seed();
    const ruleId = await saveAgentRule(seeded, "Plans", [{ name: "plan", type: "string" }]);
    await addModel(seeded);

    await run(seeded, ruleId, answering({ json: { field_plan: "Pro" } }).deps);

    expect(await fieldsOf(seeded)).toEqual([{ name: "plan", value: "Pro", ruleId }]);
  });

  describe("when the run fails", () => {
    it("waits for the pipeline to finish with the Item, and makes no call", async () => {
      const seeded = await seed();
      const ruleId = await saveAgentRule(seeded, "Plans", [{ name: "plan", type: "string" }]);
      await addModel(seeded);
      await db.update(item).set({ processedAt: null }).where(eq(item.id, seeded.itemId));

      const runId = await run(seeded, ruleId);

      expect(await callsOf(seeded)).toEqual([]);
      expect(await fieldsOf(seeded)).toEqual([]);
      expect(await logOf(seeded)).toMatchObject([
        {
          id: runId,
          message: "Manual run: Extractor Rule Plans failed: the pipeline hasn't finished with this Item yet",
          data: { manual: true, failed: true },
        },
      ]);
    });

    it("logs the provider's reason, keeps the earlier values and doesn't retry", async () => {
      const seeded = await seed();
      const ruleId = await saveAgentRule(seeded, "Plans", [{ name: "plan", type: "string" }]);
      await addModel(seeded);
      await db.insert(itemField).values({ itemId: seeded.itemId, name: "plan", value: "Old", extractorRuleId: ruleId });
      const fake = answering({ status: 500, message: "The model is down" });

      const runId = await run(seeded, ruleId, fake.deps);

      expect(fake.requests).toHaveLength(1);
      expect(await callsOf(seeded)).toMatchObject([{ purpose: "extract-rate", status: "error" }]);
      expect(await fieldsOf(seeded)).toEqual([{ name: "plan", value: "Old", ruleId }]);
      const [row] = await logOf(seeded);
      expect(row).toMatchObject({ id: runId, stage: "extract", data: { manual: true, failed: true, reason: "error" } });
      expect(row?.message).toContain("Manual run: Extractor Rule Plans failed: ");
      expect(row?.message).toContain("The model is down");
    });

    it("stores the reason a person reads under a key of its own", async () => {
      const seeded = await seed();
      const ruleId = await saveAgentRule(seeded, "Plans", [{ name: "plan", type: "string" }]);
      await addModel(seeded);

      await run(seeded, ruleId, answering({ status: 500, message: "The model is down" }).deps);

      // `reason` names the kind of failure, so the notice has this sentence to show beside it.
      const data = (await logOf(seeded))[0]?.data;
      if (typeof data !== "object" || data === null) throw new Error("Expected the Log row's data");
      expect("reason" in data ? data.reason : undefined).toBe("error");
      expect("detail" in data ? data.detail : undefined).toBe("The model provider answered 500: The model is down");
    });

    it("says so when the Workspace has no model, and makes no call", async () => {
      const seeded = await seed();
      const ruleId = await saveAgentRule(seeded, "Plans", [{ name: "plan", type: "string" }]);

      const runId = await run(seeded, ruleId);

      expect(await callsOf(seeded)).toEqual([]);
      expect(await logOf(seeded)).toMatchObject([
        {
          id: runId,
          message: "Manual run: Extractor Rule Plans failed: this Workspace has no model",
          data: { manual: true, failed: true },
        },
      ]);
    });

    it.each(["deterministic", "agent"] as const)("says so when a %s definition no longer parses", async (kind) => {
      const seeded = await seed();
      const [rule] = await db
        .insert(extractorRule)
        .values({ workspaceId: seeded.workspaceId, name: "Broken", kind, definition: { extractor: "Broken" } })
        .returning();

      const runId = await run(seeded, present(rule).id);

      expect(await logOf(seeded)).toMatchObject([
        {
          id: runId,
          message: "Manual run: Extractor Rule Broken failed: its definition no longer parses",
          data: { manual: true, failed: true },
        },
      ]);
      expect((await logOf(seeded))[0]?.data).toHaveProperty("issues");
    });

    it("stores nothing for a rule deleted during the call", async () => {
      const seeded = await seed();
      const ruleId = await saveAgentRule(seeded, "Plans", [{ name: "plan", type: "string" }]);
      await addModel(seeded);
      const fake = answering({ json: { field_plan: "Pro" } });
      const deleting: typeof fake.fetch = async (...request) => {
        await db.delete(extractorRule).where(eq(extractorRule.id, ruleId));
        return fake.fetch(...request);
      };

      await run(seeded, ruleId, { fetch: deleting, encryptionKey });

      expect(await fieldsOf(seeded)).toEqual([]);
      expect(await logOf(seeded)).toMatchObject([
        { message: "Manual run: Extractor Rule Plans failed: the rule was deleted during the run" },
      ]);
    });

    it.each([
      ["answered", { json: { field_plan: "Pro" } }],
      ["failed", { status: 500 }],
    ] as const)("does nothing for an Item deleted during a call that %s", async (_outcome, turn) => {
      const seeded = await seed();
      const ruleId = await saveAgentRule(seeded, "Plans", [{ name: "plan", type: "string" }]);
      await addModel(seeded);
      const fake = answering(turn);
      const deleting: typeof fake.fetch = async (...request) => {
        await db.delete(item).where(eq(item.id, seeded.itemId));
        return fake.fetch(...request);
      };

      expect(await run(seeded, ruleId, { fetch: deleting, encryptionKey })).toBeUndefined();
    });
  });

  it("refuses another Workspace's rule or Item", async () => {
    const ours = await seed();
    const theirs = await seed();
    const ourRule = await saveRule(ours, "CVEs", [fromTitle("cve")]);
    const theirRule = await saveRule(theirs, "CVEs", [fromTitle("cve")]);

    expect(await run(ours, theirRule)).toBeUndefined();
    expect(await run({ ...ours, itemId: theirs.itemId }, ourRule)).toBeUndefined();
    expect(await run(theirs, ourRule)).toBeUndefined();

    for (const seeded of [ours, theirs]) {
      expect(await fieldsOf(seeded)).toEqual([]);
      expect(await logOf(seeded)).toEqual([]);
    }
  });
});
