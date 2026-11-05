import { createServer } from "node:http";
import { createAgentFetch, decryptSecret } from "@watchdog/core";
import { fakeLlm } from "@watchdog/core/testing";
import {
  agentCall,
  and,
  closeDb,
  createDb,
  type Db,
  eq,
  isNull,
  migrate,
  modelConfig,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { hasActiveModel } from "./rules.ts";
import {
  getModel,
  lastFailedCall,
  type ModelDeps,
  type ModelInput,
  type ModelProblem,
  modelFormQuery,
  removeModel,
  saveModel,
  testConnection,
} from "./model.ts";

const encryptionKey = Buffer.alloc(32, 7);
const apiKey = "sk-sentinel-5f3a9c";

const input = (overrides: Partial<ModelInput> = {}): ModelInput => ({
  providerType: "openai-compatible",
  baseUrl: "https://llm.test/v1",
  modelName: "fake-model",
  apiKey: "",
  structured: false,
  inputPrice: "",
  outputPrice: "",
  ...overrides,
});

/** The value, which the test expects to be there. */
function present<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Expected a value");
  return value;
}

describe("the Model screen", () => {
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

  const save = async (workspaceId: string, overrides: Partial<ModelInput> = {}) => {
    const result = await saveModel(db, encryptionKey, workspaceId, input(overrides));
    if ("problem" in result) throw new Error(`Expected a save, got ${result.problem}`);
    return result;
  };

  /** Every row of the Workspace's models, oldest first, with what the screen never shows. */
  const rows = (workspaceId: string) =>
    db.select().from(modelConfig).where(eq(modelConfig.workspaceId, workspaceId)).orderBy(modelConfig.createdAt);

  const active = async (workspaceId: string) => {
    const [row] = await db
      .select()
      .from(modelConfig)
      .where(and(eq(modelConfig.workspaceId, workspaceId), isNull(modelConfig.archivedAt)));
    return present(row);
  };

  const fakeDeps = (turns: Parameters<typeof fakeLlm>[1]): ModelDeps & { requests: unknown[] } => {
    const fake = fakeLlm("openai-compatible", turns);
    return { encryptionKey, fetch: fake.fetch, requests: fake.requests };
  };

  describe("saving a model", () => {
    it("stores the key encrypted, and the stored value isn't the key", async () => {
      const workspaceId = await newWorkspace();

      await save(workspaceId, { apiKey });

      const { apiKeyCiphertext } = await active(workspaceId);
      expect(apiKeyCiphertext).not.toBeNull();
      expect(apiKeyCiphertext).not.toContain(apiKey);
      expect(decryptSecret(present(apiKeyCiphertext), encryptionKey)).toBe(apiKey);
    });

    it("drops the whitespace a paste brings with the key", async () => {
      const workspaceId = await newWorkspace();

      await save(workspaceId, { apiKey: `  ${apiKey}\n` });

      const { apiKeyCiphertext } = await active(workspaceId);
      expect(decryptSecret(present(apiKeyCiphertext), encryptionKey)).toBe(apiKey);
    });

    it("shows that a key is set, and neither the key nor its ciphertext", async () => {
      const workspaceId = await newWorkspace();
      await save(workspaceId, { apiKey });
      const { apiKeyCiphertext } = await active(workspaceId);

      const shown = await getModel(db, encryptionKey, workspaceId);

      expect(shown?.storedKey).toBe("set");
      expect(JSON.stringify(shown)).not.toContain(apiKey);
      expect(JSON.stringify(shown)).not.toContain(present(apiKeyCiphertext));
    });

    it("says whether the stored key can be read, without a call", async () => {
      const workspaceId = await newWorkspace();
      await save(workspaceId, { apiKey });

      const readable = await getModel(db, encryptionKey, workspaceId);
      const unreadable = await getModel(db, Buffer.alloc(32, 9), workspaceId);

      expect(readable?.storedKey).toBe("set");
      expect(unreadable?.storedKey).toBe("unreadable");
      await expect(lastFailedCall(db, workspaceId)).resolves.toBeUndefined();
    });

    it("can read a key entered again under the new encryption key", async () => {
      const workspaceId = await newWorkspace();
      await save(workspaceId, { apiKey });
      const changed = Buffer.alloc(32, 9);

      await saveModel(db, changed, workspaceId, input({ apiKey }));

      expect((await getModel(db, changed, workspaceId))?.storedKey).toBe("set");
    });

    it("has nothing to read when a model has no key", async () => {
      const workspaceId = await newWorkspace();
      await save(workspaceId, { baseUrl: "http://ollama.test:11434/v1" });

      expect((await getModel(db, Buffer.alloc(32, 9), workspaceId))?.storedKey).toBe("none");
    });

    it("lets a local model have no key", async () => {
      const workspaceId = await newWorkspace();

      await save(workspaceId, { baseUrl: "http://ollama.test:11434/v1" });

      expect(await active(workspaceId)).toMatchObject({ apiKeyCiphertext: null });
      expect((await getModel(db, encryptionKey, workspaceId))?.storedKey).toBe("none");
    });

    it("stores the prices and the flag, with a blank price as none", async () => {
      const workspaceId = await newWorkspace();

      await save(workspaceId, { structured: true, inputPrice: "2.5", outputPrice: "" });

      expect(await getModel(db, encryptionKey, workspaceId)).toMatchObject({
        supportsStructuredOutput: true,
        inputPricePerMillion: 2.5,
        outputPricePerMillion: null,
      });
    });

    it.each<[ModelProblem, Partial<ModelInput>]>([
      ["provider", { providerType: "azure" }],
      ["base-url", { baseUrl: "not a url" }],
      ["base-url", { baseUrl: "ftp://llm.test/v1" }],
      ["base-url", { baseUrl: "https://user:secret@llm.test/v1" }],
      ["base-url", { baseUrl: "https://llm.test/v1?version=1" }],
      ["model-name", { modelName: "   " }],
      ["model-name", { modelName: "x".repeat(201) }],
      ["model-name", { modelName: "fake\0model" }],
      ["model-name", { modelName: "half \ud83d a pair" }],
      ["api-key", { apiKey: "two words" }],
      ["api-key", { apiKey: "кириллица" }],
      ["input-price", { inputPrice: "-1" }],
      ["input-price", { inputPrice: "free" }],
      ["output-price", { outputPrice: "Infinity" }],
    ])("refuses with %s, and stores nothing", async (problem, overrides) => {
      const workspaceId = await newWorkspace();

      await expect(saveModel(db, encryptionKey, workspaceId, input(overrides))).resolves.toEqual({ problem });

      expect(await rows(workspaceId)).toEqual([]);
    });
  });

  describe("editing the same model", () => {
    it("updates the prices and the flag on the current row, and a blank key keeps the key", async () => {
      const workspaceId = await newWorkspace();
      await save(workspaceId, { apiKey, inputPrice: "1" });
      const before = await active(workspaceId);

      const result = await save(workspaceId, { structured: true, inputPrice: "3", outputPrice: "4" });

      expect(result.keyLeftBehind).toBe(false);
      const [only, ...others] = await rows(workspaceId);
      expect(others).toEqual([]);
      expect(only).toMatchObject({
        id: before.id,
        archivedAt: null,
        apiKeyCiphertext: before.apiKeyCiphertext,
        supportsStructuredOutput: true,
        inputPricePerMillion: 3,
        outputPricePerMillion: 4,
      });
    });

    it("clears a price left blank", async () => {
      const workspaceId = await newWorkspace();
      await save(workspaceId, { inputPrice: "1" });

      await save(workspaceId, { inputPrice: "" });

      expect((await active(workspaceId)).inputPricePerMillion).toBeNull();
    });

    it("replaces the key on the current row", async () => {
      const workspaceId = await newWorkspace();
      await save(workspaceId, { apiKey });
      const before = await active(workspaceId);

      await save(workspaceId, { apiKey: "sk-new" });

      const after = await active(workspaceId);
      expect(after.id).toBe(before.id);
      expect(decryptSecret(present(after.apiKeyCiphertext), encryptionKey)).toBe("sk-new");
    });

    it("doesn't count a trailing slash as a new base URL", async () => {
      const workspaceId = await newWorkspace();
      await save(workspaceId, { baseUrl: "https://llm.test/v1/" });

      await save(workspaceId, { baseUrl: "https://llm.test/v1" });

      expect(await rows(workspaceId)).toHaveLength(1);
    });

    it.each(["https://llm.test/v1?", "https://llm.test/v1#", "https://llm.test/v1/?"])(
      "stores %s without the empty part the SDK would append its path to",
      async (baseUrl) => {
        const workspaceId = await newWorkspace();
        await save(workspaceId, { baseUrl });

        expect((await active(workspaceId)).baseUrl).toBe("https://llm.test/v1");
      },
    );
  });

  describe("changing what ran", () => {
    it("archives the old row when the base URL changes, with its agent_call rows intact", async () => {
      const workspaceId = await newWorkspace();
      await save(workspaceId, { apiKey });
      const old = await active(workspaceId);
      await testConnection(db, fakeDeps([{ json: { reply: "ok" } }]), workspaceId);

      await save(workspaceId, { baseUrl: "https://llm.test/v2" });

      const [archived, current, ...others] = await rows(workspaceId);
      expect(others).toEqual([]);
      expect(archived?.id).toBe(old.id);
      expect(archived?.archivedAt).toBeInstanceOf(Date);
      expect(current).toMatchObject({ archivedAt: null, baseUrl: "https://llm.test/v2" });
      expect(await db.select().from(agentCall).where(eq(agentCall.workspaceId, workspaceId))).toMatchObject([
        { modelConfigId: old.id, purpose: "test-connection", status: "ok" },
      ]);
    });

    it.each<[string, Partial<ModelInput>]>([
      ["model name", { modelName: "other-model" }],
      ["path of the base URL", { baseUrl: "https://llm.test/v2" }],
    ])("carries a blank key over when only the %s changes", async (_what, change) => {
      const workspaceId = await newWorkspace();
      await save(workspaceId, { apiKey });

      const result = await save(workspaceId, change);

      expect(result.keyLeftBehind).toBe(false);
      const [archived, current] = await rows(workspaceId);
      expect(decryptSecret(present(current?.apiKeyCiphertext), encryptionKey)).toBe(apiKey);
      // One live copy: an archived row only has to say what ran.
      expect(archived?.apiKeyCiphertext).toBeNull();
    });

    it.each<[string, Partial<ModelInput>]>([
      ["host", { baseUrl: "https://elsewhere.test/v1" }],
      ["port", { baseUrl: "https://llm.test:8443/v1" }],
      ["scheme", { baseUrl: "http://llm.test/v1" }],
      ["provider type", { providerType: "anthropic" }],
    ])("doesn't send a key on to a new %s", async (_what, change) => {
      const workspaceId = await newWorkspace();
      await save(workspaceId, { apiKey });

      const result = await save(workspaceId, change);

      expect(result.keyLeftBehind).toBe(true);
      const [archived, current] = await rows(workspaceId);
      expect(current?.archivedAt).toBeNull();
      expect(current?.apiKeyCiphertext).toBeNull();
      expect(archived?.apiKeyCiphertext).toBeNull();
    });

    it("uses a key entered with the new host", async () => {
      const workspaceId = await newWorkspace();
      await save(workspaceId, { apiKey });

      const result = await save(workspaceId, { baseUrl: "https://elsewhere.test/v1", apiKey: "sk-new" });

      expect(result.keyLeftBehind).toBe(false);
      const { apiKeyCiphertext } = await active(workspaceId);
      expect(decryptSecret(present(apiKeyCiphertext), encryptionKey)).toBe("sk-new");
    });

    it("has no key to leave behind when the old model had none", async () => {
      const workspaceId = await newWorkspace();
      await save(workspaceId);

      const result = await save(workspaceId, { baseUrl: "https://elsewhere.test/v1" });

      expect(result.keyLeftBehind).toBe(false);
    });
  });

  describe("removing the model", () => {
    it("archives it, forgets the key and keeps its agent_call rows", async () => {
      const workspaceId = await newWorkspace();
      await save(workspaceId, { apiKey });
      const old = await active(workspaceId);
      await testConnection(db, fakeDeps([{ json: { reply: "ok" } }]), workspaceId);

      await expect(removeModel(db, workspaceId)).resolves.toBe(true);

      const [archived, ...others] = await rows(workspaceId);
      expect(others).toEqual([]);
      expect(archived?.archivedAt).toBeInstanceOf(Date);
      expect(archived?.apiKeyCiphertext).toBeNull();
      expect(await getModel(db, encryptionKey, workspaceId)).toBeUndefined();
      expect(await hasActiveModel(db, workspaceId)).toBe(false);
      expect(await db.select().from(agentCall).where(eq(agentCall.modelConfigId, old.id))).toHaveLength(1);
    });

    it("waits for a save in progress, which could otherwise put a key back on the archived row", async () => {
      const workspaceId = await newWorkspace();
      await save(workspaceId, { apiKey });
      let removed = false;

      const removal = await db.transaction(async (tx) => {
        // What a save holds while it reads the current row and updates it.
        await tx.select({ id: workspace.id }).from(workspace).where(eq(workspace.id, workspaceId)).for("no key update");
        const started = removeModel(db, workspaceId).then(() => {
          removed = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(removed).toBe(false);
        return { started };
      });

      await removal.started;
      expect(removed).toBe(true);
      expect((await rows(workspaceId))[0]?.apiKeyCiphertext).toBeNull();
    });

    it("returns false with no model to remove", async () => {
      await expect(removeModel(db, await newWorkspace())).resolves.toBe(false);
    });

    it("lets the Workspace add a model again", async () => {
      const workspaceId = await newWorkspace();
      await save(workspaceId);
      await removeModel(db, workspaceId);

      await save(workspaceId, { modelName: "next-model" });

      expect(await rows(workspaceId)).toHaveLength(2);
      expect(await hasActiveModel(db, workspaceId)).toBe(true);
    });
  });

  describe("testing the connection", () => {
    it("says so when the model answers", async () => {
      const workspaceId = await newWorkspace();
      await save(workspaceId, { apiKey });
      const deps = fakeDeps([{ json: { reply: "ok" } }]);

      await expect(testConnection(db, deps, workspaceId)).resolves.toBe("ok");

      expect(deps.requests).toHaveLength(1);
      expect(await lastFailedCall(db, workspaceId)).toBeUndefined();
    });

    it("reports a blocked address, and says why in plain words", async () => {
      const workspaceId = await newWorkspace();
      await save(workspaceId, { baseUrl: "http://169.254.169.254/v1" });
      const fetch = createAgentFetch({ mode: "hosted", egressAllowlist: [] });

      await expect(testConnection(db, { encryptionKey, fetch }, workspaceId)).resolves.toBe("blocked");

      const failed = await lastFailedCall(db, workspaceId);
      expect(failed?.reason).toBe(
        "Watchdog doesn't fetch 169.254.169.254: it resolves to the blocked address 169.254.169.254",
      );
    });

    it("says a provider it can't reach is unreachable", async () => {
      const workspaceId = await newWorkspace();
      const closed = createServer();
      await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
      const address = closed.address();
      if (address === null || typeof address === "string") throw new Error("Expected a port");
      await new Promise((resolve) => closed.close(resolve));
      await save(workspaceId, { baseUrl: `http://127.0.0.1:${String(address.port)}/v1` });
      const fetch = createAgentFetch({
        mode: "self-hosted",
        egressAllowlist: [{ type: "subnet", address: "127.0.0.1", prefix: 32, family: "ipv4" }],
      });

      await expect(testConnection(db, { encryptionKey, fetch }, workspaceId)).resolves.toBe("failed");

      const failed = await lastFailedCall(db, workspaceId);
      expect(failed?.reason).toMatch(/^Watchdog couldn't reach the model provider: .*ECONNREFUSED/);
    });

    it("says when the stored key can't be read, without calling the model or metering", async () => {
      const workspaceId = await newWorkspace();
      await save(workspaceId, { apiKey });
      const deps = { ...fakeDeps([]), encryptionKey: Buffer.alloc(32, 9) };

      await expect(testConnection(db, deps, workspaceId)).resolves.toBe("unreadable-key");

      expect(deps.requests).toEqual([]);
      await expect(lastFailedCall(db, workspaceId)).resolves.toBeUndefined();
    });

    it("has nothing to test without a model", async () => {
      const workspaceId = await newWorkspace();

      await expect(testConnection(db, fakeDeps([]), workspaceId)).resolves.toBe("no-model");
    });
  });

  describe("the most recent failed call", () => {
    it("shows a bad key's next failed Agent call, without the key", async () => {
      const workspaceId = await newWorkspace();
      await save(workspaceId, { apiKey });

      await testConnection(db, fakeDeps([{ status: 401, message: `Bad key: ${apiKey}` }]), workspaceId);

      const failed = await lastFailedCall(db, workspaceId);
      expect(failed?.at).toBeInstanceOf(Date);
      expect(failed?.reason).toBe("The model provider answered 401: Bad key: [redacted]");
      expect(failed?.recovered).toBe(false);
    });

    it("shows a failed pipeline call too, as a revoked key mustn't fail silently", async () => {
      const workspaceId = await newWorkspace();
      await save(workspaceId, { apiKey });

      await db.insert(agentCall).values({
        workspaceId,
        modelConfigId: (await active(workspaceId)).id,
        purpose: "extract-rate",
        attempt: 1,
        latencyMs: 5,
        status: "error",
        errorMessage: "The model provider answered 401: Revoked",
      });

      const failed = await lastFailedCall(db, workspaceId);
      expect(failed?.reason).toBe("The model provider answered 401: Revoked");
    });

    it("shows the newest of several", async () => {
      const workspaceId = await newWorkspace();
      await save(workspaceId, { apiKey });

      await testConnection(db, fakeDeps([{ status: 401, message: "First" }]), workspaceId);
      await testConnection(db, fakeDeps([{ status: 500, message: "Second" }]), workspaceId);

      const failed = await lastFailedCall(db, workspaceId);
      expect(failed?.reason).toBe("The model provider answered 500: Second");
    });

    it("says when a later call worked", async () => {
      const workspaceId = await newWorkspace();
      await save(workspaceId, { apiKey });

      await testConnection(db, fakeDeps([{ status: 401, message: "Revoked" }]), workspaceId);
      await testConnection(db, fakeDeps([{ json: { reply: "ok" } }]), workspaceId);

      expect((await lastFailedCall(db, workspaceId))?.recovered).toBe(true);
    });

    it("ignores the failures of a model that has been replaced", async () => {
      const workspaceId = await newWorkspace();
      await save(workspaceId, { apiKey });
      await testConnection(db, fakeDeps([{ status: 401, message: "Revoked" }]), workspaceId);

      await save(workspaceId, { baseUrl: "https://elsewhere.test/v1" });

      expect(await lastFailedCall(db, workspaceId)).toBeUndefined();
    });
  });

  describe("a second Workspace", () => {
    it("can't read, change, test or remove this Workspace's model", async () => {
      const mine = await newWorkspace();
      const other = await newWorkspace();
      await save(mine, { apiKey, inputPrice: "1" });
      await testConnection(db, fakeDeps([{ status: 401, message: "Revoked" }]), mine);
      const before = await active(mine);

      expect(await getModel(db, encryptionKey, other)).toBeUndefined();
      expect(await lastFailedCall(db, other)).toBeUndefined();
      await expect(testConnection(db, fakeDeps([]), other)).resolves.toBe("no-model");
      await expect(removeModel(db, other)).resolves.toBe(false);
      await save(other, { modelName: "theirs", inputPrice: "9" });

      expect(await rows(mine)).toEqual([before]);
      expect(await active(other)).toMatchObject({ modelName: "theirs", inputPricePerMillion: 9 });
    });
  });

  describe("going back to the form after a refusal", () => {
    it("keeps what was entered, and never the key", () => {
      const query = modelFormQuery("model-name", input({ apiKey, structured: true, inputPrice: "2" }));

      expect(query.toString()).not.toContain(apiKey);
      expect(Object.fromEntries(query)).toEqual({
        error: "model-name",
        providerType: "openai-compatible",
        baseUrl: "https://llm.test/v1",
        modelName: "fake-model",
        structured: "1",
        inputPrice: "2",
        outputPrice: "",
        keyTyped: "1",
      });
    });

    it.each([
      ["a user name and password", "https://user:sk-sentinel@llm.test/v1", "https://llm.test/v1"],
      ["a query", "https://llm.test/v1beta?key=sk-sentinel", "https://llm.test/v1beta"],
      ["a fragment", "https://llm.test/v1#sk-sentinel", "https://llm.test/v1"],
      ["no address at all", "sk-sentinel", ""],
      ["another scheme", "ftp://sk-sentinel@llm.test/v1", ""],
    ])("doesn't put a secret in the URL when a base URL holds %s", (_what, baseUrl, kept) => {
      const query = modelFormQuery("base-url", input({ baseUrl }));

      expect(query.toString()).not.toContain("sk-sentinel");
      expect(query.get("baseUrl")).toBe(kept);
    });

    it("leaves out a base URL too long to go in a URL", () => {
      const query = modelFormQuery("base-url", input({ baseUrl: `https://llm.test/${"x".repeat(3000)}` }));

      expect(query.get("baseUrl")).toBe("");
    });

    it("says nothing about a key that wasn't typed", () => {
      const query = modelFormQuery("base-url", input());

      expect(query.has("keyTyped")).toBe(false);
      expect(query.has("structured")).toBe(false);
    });
  });
});
