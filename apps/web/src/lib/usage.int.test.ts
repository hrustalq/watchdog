import { agentCall, closeDb, createDb, type Db, migrate, modelConfig, user, workspace } from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { saveModel } from "./model.ts";
import { isFloor, usageForMonth } from "./usage.ts";

const month = "2026-10";
const inMonth = new Date("2026-10-15T12:00:00.000Z");

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}

describe("the Usage screen", () => {
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

  async function newWorkspace() {
    const id = crypto.randomUUID();
    await db.insert(user).values({ id, name: "Owner", email: `${id}@example.com` });
    const [row] = await db.insert(workspace).values({ name: "Workspace", ownerUserId: id }).returning();
    return present(row).id;
  }

  async function newModel(workspaceId: string, values: Partial<typeof modelConfig.$inferInsert> = {}) {
    const [row] = await db
      .insert(modelConfig)
      .values({
        workspaceId,
        providerType: "openai-compatible",
        baseUrl: "https://llm.test/v1",
        modelName: "fake-model",
        ...values,
      })
      .returning();
    return present(row);
  }

  type Model = Awaited<ReturnType<typeof newModel>>;

  const call = (model: Model, values: Partial<typeof agentCall.$inferInsert> = {}) =>
    db.insert(agentCall).values({
      workspaceId: model.workspaceId,
      modelConfigId: model.id,
      purpose: "extract-rate",
      attempt: 1,
      inputTokens: 100,
      outputTokens: 10,
      latencyMs: 5,
      status: "ok",
      createdAt: inMonth,
      ...values,
    });

  describe("a month's totals", () => {
    it("equal the agent_call rows, per model", async () => {
      const workspaceId = await newWorkspace();
      const model = await newModel(workspaceId);
      await call(model);
      await call(model, { inputTokens: 1000, outputTokens: 200 });
      await call(model, { status: "invalid_output", inputTokens: 30, outputTokens: 3, attempt: 2 });
      await call(model, { status: "error", inputTokens: null, outputTokens: null });

      const usage = await usageForMonth(db, workspaceId, month);

      expect(usage.models).toHaveLength(1);
      expect(usage.models[0]).toMatchObject({
        modelName: "fake-model",
        calls: 4,
        failed: 2,
        inputTokens: 1130,
        outputTokens: 213,
      });
    });

    it("never include another Workspace's calls", async () => {
      const workspaceId = await newWorkspace();
      await call(await newModel(workspaceId), { inputTokens: 7, outputTokens: 1 });
      await call(await newModel(await newWorkspace()), { inputTokens: 900, outputTokens: 90 });

      const usage = await usageForMonth(db, workspaceId, month);

      expect(usage.models.map(({ calls, inputTokens }) => ({ calls, inputTokens }))).toEqual([
        { calls: 1, inputTokens: 7 },
      ]);
    });

    it("count a call with no reported tokens as a call, and say how many there were", async () => {
      const workspaceId = await newWorkspace();
      const model = await newModel(workspaceId);
      await call(model);
      await call(model, { inputTokens: null, outputTokens: null });
      await call(model, { inputTokens: 50, outputTokens: null, status: "invalid_output" });

      const { models, total } = await usageForMonth(db, workspaceId, month);

      expect(models[0]).toMatchObject({ calls: 3, withoutTokens: 2, inputTokens: 150, outputTokens: 10 });
      expect(total).toMatchObject({ calls: 3, withoutTokens: 2 });
    });

    it("don't call a refused attempt understated, since no answer came with counts to report", async () => {
      const workspaceId = await newWorkspace();
      await call(await newModel(workspaceId), { status: "error", inputTokens: null, outputTokens: null });

      const { total } = await usageForMonth(db, workspaceId, month);

      expect(total).toMatchObject({ calls: 1, failed: 1, withoutTokens: 0 });
    });

    it("add up across models", async () => {
      const workspaceId = await newWorkspace();
      await call(await newModel(workspaceId, { modelName: "one", archivedAt: inMonth }));
      await call(await newModel(workspaceId, { modelName: "two" }), { status: "error" });

      const { total } = await usageForMonth(db, workspaceId, month);

      expect(total).toMatchObject({ calls: 2, failed: 1, inputTokens: 200, outputTokens: 20 });
    });

    it("are nothing in a month without calls", async () => {
      const usage = await usageForMonth(db, await newWorkspace(), month);

      expect(usage.models).toEqual([]);
      expect(usage.purposes).toEqual([]);
      expect(usage.total).toMatchObject({ calls: 0, inputTokens: 0, outputTokens: 0 });
    });
  });

  describe("a replaced model", () => {
    it("keeps its usage under its own name", async () => {
      const workspaceId = await newWorkspace();
      const encryptionKey = Buffer.alloc(32, 7);
      const form = {
        providerType: "openai-compatible",
        baseUrl: "https://llm.test/v1",
        apiKey: "",
        structured: false,
        inputPrice: "",
        outputPrice: "",
        clearKey: false,
      };
      await saveModel(db, encryptionKey, workspaceId, { ...form, modelName: "first" });
      const first = present(await db.query.modelConfig.findFirst({ where: (m, { eq }) => eq(m.workspaceId, workspaceId) }));
      await call(first, { inputTokens: 11, outputTokens: 1 });

      await saveModel(db, encryptionKey, workspaceId, { ...form, modelName: "second" });
      const second = present(
        await db.query.modelConfig.findFirst({
          where: (m, { and, eq, isNull }) => and(eq(m.workspaceId, workspaceId), isNull(m.archivedAt)),
        }),
      );
      await call(second, { inputTokens: 22, outputTokens: 2 });

      const { models } = await usageForMonth(db, workspaceId, month);

      expect(models.find((row) => row.modelName === "first")).toMatchObject({ archived: true, inputTokens: 11 });
      expect(models.find((row) => row.modelName === "second")).toMatchObject({ archived: false, inputTokens: 22 });
    });

    it("stays apart from a later model with the same name, because it ran somewhere else", async () => {
      const workspaceId = await newWorkspace();
      await call(await newModel(workspaceId, { baseUrl: "https://old.test/v1", archivedAt: inMonth }));
      await call(await newModel(workspaceId, { baseUrl: "https://new.test/v1" }));

      const { models } = await usageForMonth(db, workspaceId, month);

      expect(models.map(({ baseUrl }) => baseUrl).toSorted()).toEqual(["https://new.test/v1", "https://old.test/v1"]);
    });

    it("is one line when it's added back, adding up both rows at each row's own prices", async () => {
      const workspaceId = await newWorkspace();
      const before = await newModel(workspaceId, {
        archivedAt: inMonth,
        inputPricePerMillion: 2,
        outputPricePerMillion: 10,
      });
      await call(before, { inputTokens: 1_000_000, outputTokens: 100_000 });
      const after = await newModel(workspaceId, { inputPricePerMillion: 4, outputPricePerMillion: 20 });
      await call(after, { inputTokens: 500_000, outputTokens: 50_000 });

      const { models, total } = await usageForMonth(db, workspaceId, month);

      // 1M input at 2.00 and 100k output at 10.00 is 3.00, and 500k at 4.00 and 50k at 20.00 is 3.00.
      expect(models).toHaveLength(1);
      expect(present(models[0])).toMatchObject({
        modelName: "fake-model",
        archived: false,
        calls: 2,
        inputTokens: 1_500_000,
        outputTokens: 150_000,
        unpricedCalls: 0,
      });
      expect(present(models[0]).cost).toBeCloseTo(6, 10);
      expect(total).toMatchObject({ calls: 2, inputTokens: 1_500_000, outputTokens: 150_000, unpricedCalls: 0 });
      expect(total.cost).toBeCloseTo(6, 10);
    });

    it("is a floor when one of its rows ran without prices", async () => {
      const workspaceId = await newWorkspace();
      const priced = await newModel(workspaceId, {
        archivedAt: inMonth,
        inputPricePerMillion: 2,
        outputPricePerMillion: 10,
      });
      await call(priced, { inputTokens: 1_000_000, outputTokens: 0 });
      await call(await newModel(workspaceId), { inputTokens: 7, outputTokens: 1 });

      const { models, total } = await usageForMonth(db, workspaceId, month);

      expect(present(models[0])).toMatchObject({ calls: 2, unpricedCalls: 1 });
      expect(present(models[0]).cost).toBeCloseTo(2, 10);
      expect(isFloor(present(models[0]))).toBe(true);
      expect(isFloor(total)).toBe(true);
    });

    it("says Archived only when none of its rows is active", async () => {
      const workspaceId = await newWorkspace();
      await call(await newModel(workspaceId, { archivedAt: inMonth }));
      await call(await newModel(workspaceId, { archivedAt: inMonth }));

      const { models } = await usageForMonth(db, workspaceId, month);

      expect(models).toHaveLength(1);
      expect(present(models[0]).archived).toBe(true);
    });

    it("stays apart from the same name and address on another provider type", async () => {
      const workspaceId = await newWorkspace();
      await call(await newModel(workspaceId, { archivedAt: inMonth }));
      await call(await newModel(workspaceId, { providerType: "anthropic" }));

      const { models } = await usageForMonth(db, workspaceId, month);

      expect(models.map(({ providerType }) => providerType).toSorted()).toEqual(["anthropic", "openai-compatible"]);
    });
  });

  describe("the month", () => {
    it("runs from the first to the last instant of the UTC month", async () => {
      const workspaceId = await newWorkspace();
      const model = await newModel(workspaceId);
      const at = (createdAt: string, inputTokens: number) => call(model, { createdAt: new Date(createdAt), inputTokens });
      await at("2026-09-30T23:59:59.999Z", 1);
      await at("2026-10-01T00:00:00.000Z", 10);
      await at("2026-10-31T23:59:59.999Z", 100);
      // Still October in UTC, though it's November where this was written.
      await at("2026-11-01T01:00:00.000+03:00", 1000);
      await at("2026-11-01T00:00:00.000Z", 10_000);

      const { total } = await usageForMonth(db, workspaceId, month);

      expect(total).toMatchObject({ calls: 3, inputTokens: 1110 });
    });

    it("crosses into the next year after December", async () => {
      const workspaceId = await newWorkspace();
      const model = await newModel(workspaceId);
      await call(model, { createdAt: new Date("2026-12-31T23:00:00.000Z") });
      await call(model, { createdAt: new Date("2027-01-01T00:00:00.000Z") });

      expect((await usageForMonth(db, workspaceId, "2026-12")).total.calls).toBe(1);
      expect((await usageForMonth(db, workspaceId, "2027-01")).total.calls).toBe(1);
    });

    it("reports the Workspace's earliest month with calls, whichever month is asked for", async () => {
      const workspaceId = await newWorkspace();
      const model = await newModel(workspaceId);
      await call(model, { createdAt: new Date("2026-08-31T23:59:59.000Z") });
      await call(model);

      expect((await usageForMonth(db, workspaceId, month)).firstMonth).toBe("2026-08");
      expect((await usageForMonth(db, workspaceId, "2026-11")).firstMonth).toBe("2026-08");
      expect((await usageForMonth(db, await newWorkspace(), month)).firstMonth).toBeUndefined();
    });
  });

  describe("the breakdown by purpose", () => {
    it("adds up each purpose across models, largest first", async () => {
      const workspaceId = await newWorkspace();
      const one = await newModel(workspaceId, { modelName: "one", archivedAt: inMonth });
      const two = await newModel(workspaceId, { modelName: "two" });
      await call(one, { purpose: "classify", inputTokens: 100, outputTokens: 10 });
      await call(two, { purpose: "classify", inputTokens: 200, outputTokens: 20 });
      await call(two, { purpose: "extract-rate", inputTokens: 5000, outputTokens: 500, status: "error" });
      await call(two, { purpose: "test-connection", inputTokens: 1, outputTokens: 1 });

      const { purposes } = await usageForMonth(db, workspaceId, month);

      expect(purposes.map(({ purpose, calls, failed, inputTokens, outputTokens }) => ({
        purpose,
        calls,
        failed,
        inputTokens,
        outputTokens,
      }))).toEqual([
        { purpose: "extract-rate", calls: 1, failed: 1, inputTokens: 5000, outputTokens: 500 },
        { purpose: "classify", calls: 2, failed: 0, inputTokens: 300, outputTokens: 30 },
        { purpose: "test-connection", calls: 1, failed: 0, inputTokens: 1, outputTokens: 1 },
      ]);
    });
  });

  it("keeps rows with the same size in one order", async () => {
    const workspaceId = await newWorkspace();
    const model = await newModel(workspaceId);
    await call(model, { purpose: "test-connection", inputTokens: null, outputTokens: null });
    await call(model, { purpose: "classify", inputTokens: null, outputTokens: null });
    await call(model, { purpose: "compile-rule", inputTokens: null, outputTokens: null });

    const { purposes } = await usageForMonth(db, workspaceId, month);

    expect(purposes.map(({ purpose }) => purpose)).toEqual(["classify", "compile-rule", "test-connection"]);
  });

  describe("the estimated cost", () => {
    const priced = { inputPricePerMillion: 2.5, outputPricePerMillion: 10 };

    it("comes from the model's prices per million tokens", async () => {
      const workspaceId = await newWorkspace();
      const model = await newModel(workspaceId, priced);
      await call(model, { inputTokens: 1_000_000, outputTokens: 100_000 });
      await call(model, { inputTokens: 200_000, outputTokens: 0, purpose: "classify" });

      const { models, purposes, total } = await usageForMonth(db, workspaceId, month);

      // 1.2M input at 2.50 is 3.00, and 100k output at 10 is 1.00.
      expect(present(models[0]).cost).toBeCloseTo(4, 10);
      expect(total.cost).toBeCloseTo(4, 10);
      expect(purposes.find((row) => row.purpose === "extract-rate")?.cost).toBeCloseTo(3.5, 10);
      expect(purposes.find((row) => row.purpose === "classify")?.cost).toBeCloseTo(0.5, 10);
    });

    it("is absent without prices", async () => {
      const workspaceId = await newWorkspace();
      await call(await newModel(workspaceId));

      const { models, purposes, total } = await usageForMonth(db, workspaceId, month);

      expect(present(models[0]).cost).toBeNull();
      expect(present(purposes[0]).cost).toBeNull();
      expect(total.cost).toBeNull();
    });

    it("is absent with only one price, since half an estimate would understate it", async () => {
      const workspaceId = await newWorkspace();
      await call(await newModel(workspaceId, { inputPricePerMillion: 2.5 }));

      expect(present((await usageForMonth(db, workspaceId, month)).models[0]).cost).toBeNull();
    });

    it("counts a free model's price of zero as a price", async () => {
      const workspaceId = await newWorkspace();
      await call(await newModel(workspaceId, { inputPricePerMillion: 0, outputPricePerMillion: 0 }));

      expect(present((await usageForMonth(db, workspaceId, month)).models[0]).cost).toBe(0);
    });

    it("keeps each model's own cost, and counts what a total leaves out", async () => {
      const workspaceId = await newWorkspace();
      const pricedModel = await newModel(workspaceId, { modelName: "priced", ...priced });
      const unpriced = await newModel(workspaceId, { modelName: "unpriced", archivedAt: inMonth });
      await call(pricedModel, { inputTokens: 1_000_000, outputTokens: 0 });
      await call(unpriced);
      await call(unpriced, { purpose: "classify" });

      const { models, purposes, total } = await usageForMonth(db, workspaceId, month);

      expect(models.find((row) => row.modelName === "priced")).toMatchObject({ unpricedCalls: 0 });
      expect(models.find((row) => row.modelName === "priced")?.cost).toBeCloseTo(2.5, 10);
      expect(models.find((row) => row.modelName === "unpriced")).toMatchObject({ cost: null, unpricedCalls: 2 });
      expect(total.cost).toBeCloseTo(2.5, 10);
      expect(total.unpricedCalls).toBe(2);
      expect(purposes.find((row) => row.purpose === "extract-rate")).toMatchObject({ unpricedCalls: 1 });
      expect(purposes.find((row) => row.purpose === "extract-rate")?.cost).toBeCloseTo(2.5, 10);
      expect(purposes.find((row) => row.purpose === "classify")).toMatchObject({ cost: null, unpricedCalls: 1 });
    });
  });

  it("reads from the (workspace_id, created_at) index", async () => {
    const workspaceId = await newWorkspace();
    await call(await newModel(workspaceId));

    const query = vi.spyOn(db.$client, "query");
    await usageForMonth(db, workspaceId, month);
    const sent = query.mock.calls.map((args): unknown[] => args);
    query.mockRestore();
    expect(sent).toHaveLength(2);

    for (const [config, params] of sent) {
      if (typeof config !== "object" || config === null || !("text" in config)) throw new Error("No query");
      const client = await db.$client.connect();
      try {
        // Tiny tables make these scans cheapest, so forbid them to see what the query can use.
        await client.query("begin");
        await client.query("set local enable_seqscan = off");
        await client.query("set local enable_bitmapscan = off");
        const plan = await client.query<{ "QUERY PLAN": string }>(
          `explain ${String(config.text)}`,
          Array.isArray(params) ? params : [],
        );
        await client.query("rollback");
        expect(plan.rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain("agent_call_workspace_id_created_at_idx");
      } finally {
        client.release();
      }
    }
  });
});
