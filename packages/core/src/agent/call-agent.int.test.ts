import { createServer, type Server } from "node:http";
import {
  agentCall,
  closeDb,
  createDb,
  type Db,
  eq,
  item,
  itemLog,
  migrate,
  modelConfig,
  source,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres, type TestPostgres } from "@watchdog/db/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type EgressRule, parseEgressRule } from "../egress/egress.ts";
import { encryptSecret } from "../secrets/secrets.ts";
import { type AgentResult, callAgent } from "./call-agent.ts";
import { type FakeRequest, fakeLlm } from "./fake-llm.ts";
import { createAgentFetch } from "./provider.ts";

const encryptionKey = Buffer.alloc(32, 7);
const apiKey = "sk-sentinel-5f3a9c";
const schema = z.object({
  severity: z.number().int().min(1).max(5),
  summary: z.string(),
});
const valid = { severity: 4, summary: "An outage" };
const invalid = { severity: 9, summary: "An outage" };

const families = [
  { providerType: "openai-compatible", path: "/v1" },
  { providerType: "anthropic", path: "/v1" },
  { providerType: "google", path: "/v1beta" },
] as const;
type ProviderType = (typeof families)[number]["providerType"];

/** The value, which the test expects to be there. */
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}

const allow = (entry: string): EgressRule => present(parseEgressRule(entry));

/** The failure, which the test expects. */
function failed<Value>(result: AgentResult<Value>) {
  if (result.ok) throw new Error("Expected a failure");
  return result;
}

describe("callAgent", () => {
  let postgres: TestPostgres;
  let db: Db;
  let server: Server;
  let port: number;
  /** What the local server answers with. It stands in for a model on the operator's network. */
  let answer: ReturnType<typeof fakeLlm>;

  beforeAll(async () => {
    postgres = await startPostgres();
    await migrate(postgres.url);
    db = createDb(postgres.url);
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        void answer.fetch(`http://local${req.url ?? ""}`, { method: "POST", body }).then(async (response) => {
          res.statusCode = response.status;
          res.setHeader("content-type", "application/json");
          res.end(await response.text());
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected a port");
    port = address.port;
    return async () => {
      await closeDb(db);
      await postgres.stop();
    };
  }, 120_000);

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  /** A new Workspace with an Item and a model of this family. */
  async function seed(
    providerType: ProviderType,
    overrides: { baseUrl?: string; structured?: boolean; ciphertext?: string | null } = {},
  ) {
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
    const [captured] = await db
      .insert(item)
      .values({
        workspaceId,
        sourceId: present(src).id,
        externalId: id,
        title: "Title",
        body: "Body",
        raw: {},
      })
      .returning();
    const [model] = await db
      .insert(modelConfig)
      .values({
        workspaceId,
        providerType,
        baseUrl: overrides.baseUrl ?? "https://llm.test/v1",
        modelName: "fake-model",
        apiKeyCiphertext:
          overrides.ciphertext === undefined ? encryptSecret(apiKey, encryptionKey) : overrides.ciphertext,
        supportsStructuredOutput: overrides.structured ?? false,
      })
      .returning();
    return { workspaceId, itemId: present(captured).id, modelConfig: present(model) };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  const call = (seeded: Seeded, fetch: ReturnType<typeof fakeLlm>["fetch"]) =>
    callAgent({
      db,
      encryptionKey,
      ...seeded,
      purpose: "extract-rate",
      schema,
      system: "You rate Items.",
      prompt: "Rate this Item.",
      fetch,
    });

  const rows = (seeded: Seeded) =>
    db
      .select()
      .from(agentCall)
      .where(eq(agentCall.workspaceId, seeded.workspaceId))
      .orderBy(agentCall.attempt);

  const textOf = (request: FakeRequest | undefined) => JSON.stringify(request?.body);

  describe.each(families)("with $providerType", ({ providerType, path }) => {
    it("returns validated output and meters the attempt", async () => {
      const seeded = await seed(providerType);
      const fake = fakeLlm(providerType, [{ json: valid, usage: { inputTokens: 21, outputTokens: 8 } }]);

      await expect(call(seeded, fake.fetch)).resolves.toEqual({ ok: true, output: valid });

      const [row, ...others] = await rows(seeded);
      expect(others).toEqual([]);
      expect(row).toMatchObject({
        workspaceId: seeded.workspaceId,
        modelConfigId: seeded.modelConfig.id,
        itemId: seeded.itemId,
        purpose: "extract-rate",
        attempt: 1,
        inputTokens: 21,
        outputTokens: 8,
        status: "ok",
      });
      expect(row?.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("sends one request to the configured base URL with the key", async () => {
      const seeded = await seed(providerType, { baseUrl: `https://llm.test${path}` });
      const fake = fakeLlm(providerType, [{ json: valid }]);

      await call(seeded, fake.fetch);

      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]?.url).toContain(`https://llm.test${path}/`);
      expect(Object.values(fake.requests[0]?.headers ?? {}).join(" ")).toContain(apiKey);
    });

    it("repairs an invalid response once, with the validation error", async () => {
      const seeded = await seed(providerType);
      const fake = fakeLlm(providerType, [{ json: invalid }, { json: valid }]);

      await expect(call(seeded, fake.fetch)).resolves.toEqual({ ok: true, output: valid });

      expect(textOf(fake.requests[1])).toContain("Rate this Item.");
      expect(textOf(fake.requests[1])).toContain("at severity");
      expect(textOf(fake.requests[0])).not.toContain("at severity");
      expect(await rows(seeded)).toMatchObject([
        { attempt: 1, status: "invalid_output", inputTokens: 10, outputTokens: 5 },
        { attempt: 2, status: "ok", inputTokens: 10, outputTokens: 5 },
      ]);
    });

    it("repairs a response that isn't JSON", async () => {
      const seeded = await seed(providerType);
      const fake = fakeLlm(providerType, [{ text: "It looks bad." }, { json: valid }]);

      await expect(call(seeded, fake.fetch)).resolves.toEqual({ ok: true, output: valid });
      expect(textOf(fake.requests[1])).toContain("no code fences");
      expect(await rows(seeded)).toMatchObject([{ status: "invalid_output" }, { status: "ok" }]);
    });

    it("fails after a second invalid response, with one row per attempt", async () => {
      const seeded = await seed(providerType);
      const fake = fakeLlm(providerType, [{ json: invalid }, { json: invalid }]);

      const { reason, message } = failed(await call(seeded, fake.fetch));
      expect(reason).toBe("invalid_output");
      expect(message).toContain("at severity");

      expect(fake.requests).toHaveLength(2);
      expect(await rows(seeded)).toMatchObject([
        { attempt: 1, status: "invalid_output" },
        { attempt: 2, status: "invalid_output" },
      ]);
    });

    it("treats a refusal as invalid output and meters it", async () => {
      const seeded = await seed(providerType);
      const fake = fakeLlm(providerType, [{ refused: true }, { refused: true }]);

      await expect(call(seeded, fake.fetch)).resolves.toMatchObject({ ok: false, reason: "invalid_output" });
      expect(await rows(seeded)).toMatchObject([
        { attempt: 1, status: "invalid_output", inputTokens: 10 },
        { attempt: 2, status: "invalid_output", inputTokens: 10 },
      ]);
    });

    it("fails on a 500 without retrying, so pg-boss alone retries", async () => {
      const seeded = await seed(providerType);
      const fake = fakeLlm(providerType, [{ status: 500, message: "The model is down" }]);

      const { reason, message } = failed(await call(seeded, fake.fetch));
      expect(reason).toBe("error");
      expect(message).toBe("The model provider answered 500: The model is down");

      expect(fake.requests).toHaveLength(1);
      expect(await rows(seeded)).toMatchObject([
        { attempt: 1, status: "error", inputTokens: null, outputTokens: null },
      ]);
    });

    it("returns a readable failure for a base URL the egress guard blocks on hosted", async () => {
      const seeded = await seed(providerType, { baseUrl: `http://127.0.0.1:${String(port)}${path}` });
      answer = fakeLlm(providerType, [{ json: valid }]);
      const fetch = createAgentFetch({ mode: "hosted", egressAllowlist: [allow("127.0.0.1")] });

      const { reason, message } = failed(await call(seeded, fetch));
      expect(reason).toBe("blocked");
      expect(message).toContain("Watchdog doesn't fetch 127.0.0.1");

      expect(answer.requests).toEqual([]);
      expect(await rows(seeded)).toMatchObject([{ attempt: 1, status: "error" }]);
    });

    it("reaches a blocked address on self-hosted through EGRESS_ALLOWLIST", async () => {
      const seeded = await seed(providerType, { baseUrl: `http://127.0.0.1:${String(port)}${path}` });
      answer = fakeLlm(providerType, [{ json: valid }]);
      const fetch = createAgentFetch({ mode: "self-hosted", egressAllowlist: [allow("127.0.0.1")] });

      await expect(call(seeded, fetch)).resolves.toEqual({ ok: true, output: valid });

      expect(answer.requests).toHaveLength(1);
      expect(await rows(seeded)).toMatchObject([{ attempt: 1, status: "ok" }]);
    });

    it("never puts the API key in a row or an error, even when the provider echoes it", async () => {
      const seeded = await seed(providerType);
      const fake = fakeLlm(providerType, [{ status: 401, message: `Bad key: ${apiKey}` }]);

      const result = await call(seeded, fake.fetch);

      expect(result).toMatchObject({ ok: false, reason: "error" });
      expect(JSON.stringify(result)).not.toContain(apiKey);
      const stored = [
        await rows(seeded),
        await db.select().from(itemLog).where(eq(itemLog.itemId, seeded.itemId)),
      ];
      expect(JSON.stringify(stored)).not.toContain(apiKey);
    });
  });

  describe("token counts a host reports", () => {
    // Each would make the insert fail, and lose an answer the user paid for, or corrupt Usage.
    it.each([12.5, 3_000_000_000, -1])("stores null for %d and keeps the answer", async (inputTokens) => {
      const seeded = await seed("openai-compatible");
      const fake = fakeLlm("openai-compatible", [{ json: valid, usage: { inputTokens, outputTokens: 5 } }]);

      await expect(call(seeded, fake.fetch)).resolves.toEqual({ ok: true, output: valid });

      expect(await rows(seeded)).toMatchObject([{ status: "ok", inputTokens: null, outputTokens: 5 }]);
    });
  });

  describe("a response with no usage block", () => {
    it.each(["openai-compatible", "google"] as const)("stores null tokens with %s", async (providerType) => {
      const seeded = await seed(providerType);
      const fake = fakeLlm(providerType, [{ json: valid, usage: null }]);

      await expect(call(seeded, fake.fetch)).resolves.toEqual({ ok: true, output: valid });

      expect(await rows(seeded)).toMatchObject([{ status: "ok", inputTokens: null, outputTokens: null }]);
    });

    // The Anthropic provider's response schema requires usage, and its API always sends it.
    it("fails with anthropic, and still stores null tokens", async () => {
      const seeded = await seed("anthropic");
      const fake = fakeLlm("anthropic", [{ json: valid, usage: null }]);

      await expect(call(seeded, fake.fetch)).resolves.toMatchObject({ ok: false, reason: "error" });

      expect(await rows(seeded)).toMatchObject([{ status: "error", inputTokens: null, outputTokens: null }]);
    });
  });

  describe("the structured output flag", () => {
    const shapeInPrompt = '"severity"';

    it("openai-compatible asks for a JSON schema with the flag", async () => {
      const fake = fakeLlm("openai-compatible", [{ json: valid }]);
      await call(await seed("openai-compatible", { structured: true }), fake.fetch);
      expect(fake.requests[0]?.body).toMatchObject({ response_format: { type: "json_schema" } });
    });

    it("openai-compatible asks for plain JSON without the flag, and gives the shape in the prompt", async () => {
      const fake = fakeLlm("openai-compatible", [{ json: valid }]);
      await call(await seed("openai-compatible", { structured: false }), fake.fetch);
      expect(fake.requests[0]?.body).toMatchObject({ response_format: { type: "json_object" } });
      expect(textOf(fake.requests[0])).toContain(shapeInPrompt.replaceAll('"', String.raw`\"`));
    });

    it("anthropic uses native structured output with the flag", async () => {
      const fake = fakeLlm("anthropic", [{ json: valid }]);
      await call(await seed("anthropic", { structured: true }), fake.fetch);
      expect(fake.requests[0]?.body).toMatchObject({ output_config: { format: { type: "json_schema" } } });
    });

    it("anthropic works through the tool call without the flag", async () => {
      const fake = fakeLlm("anthropic", [{ json: valid }]);
      await call(await seed("anthropic", { structured: false }), fake.fetch);
      expect(fake.requests[0]?.body).toMatchObject({ tools: [{ name: "json" }] });
      expect(textOf(fake.requests[0])).not.toContain("Respond with only");
    });

    it("google sends the response schema with the flag", async () => {
      const fake = fakeLlm("google", [{ json: valid }]);
      await call(await seed("google", { structured: true }), fake.fetch);
      expect(fake.requests[0]?.body).toMatchObject({
        generationConfig: { responseMimeType: "application/json", responseJsonSchema: { type: "object" } },
      });
    });

    it("google asks for plain JSON without the flag, and gives the shape in the prompt", async () => {
      const fake = fakeLlm("google", [{ json: valid }]);
      await call(await seed("google", { structured: false }), fake.fetch);
      expect(textOf(fake.requests[0])).not.toContain("responseJsonSchema");
      expect(fake.requests[0]?.body).toMatchObject({
        generationConfig: { responseMimeType: "application/json" },
      });
      expect(textOf(fake.requests[0])).toContain(shapeInPrompt.replaceAll('"', String.raw`\"`));
    });
  });

  describe("the API key", () => {
    it.each(families)(
      "with $providerType, a model without a key never picks one up from the environment",
      async ({ providerType }) => {
        vi.stubEnv("ANTHROPIC_API_KEY", "env-key-sentinel");
        vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "env-key-sentinel");
        try {
          const fake = fakeLlm(providerType, [{ json: valid }]);
          const result = await call(await seed(providerType, { ciphertext: null }), fake.fetch);
          expect(result).toEqual({ ok: true, output: valid });
          expect(JSON.stringify(fake.requests[0]?.headers)).not.toContain("env-key-sentinel");
        } finally {
          vi.unstubAllEnvs();
        }
      },
    );

    it("redacts the key as it goes on the wire when it was stored with stray whitespace", async () => {
      const seeded = await seed("anthropic", { ciphertext: encryptSecret(`${apiKey}\n`, encryptionKey) });
      const fake = fakeLlm("anthropic", [{ status: 401, message: `Bad key: ${apiKey}` }]);

      const { message } = failed(await call(seeded, fake.fetch));

      expect(fake.requests[0]?.headers["x-api-key"]).toBe(apiKey);
      expect(message).not.toContain(apiKey);
    });

    it("fails without a request or a row when the key can't be decrypted", async () => {
      const seeded = await seed("anthropic", { ciphertext: encryptSecret(apiKey, Buffer.alloc(32, 9)) });
      const fake = fakeLlm("anthropic", []);

      const { reason, message } = failed(await call(seeded, fake.fetch));
      expect(reason).toBe("error");
      expect(message).toContain("Can't decrypt");

      expect(fake.requests).toEqual([]);
      expect(await rows(seeded)).toEqual([]);
    });
  });

  it("refuses another Workspace's model before it spends anything", async () => {
    const seeded = await seed("openai-compatible");
    const other = await seed("openai-compatible");
    const fake = fakeLlm("openai-compatible", []);

    const { reason } = failed(await call({ ...seeded, modelConfig: other.modelConfig }, fake.fetch));

    expect(reason).toBe("error");
    expect(fake.requests).toEqual([]);
    expect(await rows(seeded)).toEqual([]);
  });

  it("fails without a request or a row when the schema has no JSON Schema form", async () => {
    const seeded = await seed("openai-compatible", { structured: false });
    const fake = fakeLlm("openai-compatible", []);

    const { reason } = failed(
      await callAgent({
        db,
        encryptionKey,
        ...seeded,
        purpose: "classify",
        schema: z.object({ at: z.date() }),
        system: "You classify Items.",
        prompt: "Classify this Item.",
        fetch: fake.fetch,
      }),
    );

    expect(reason).toBe("error");
    expect(fake.requests).toEqual([]);
    expect(await rows(seeded)).toEqual([]);
  });

  it("meters a call with no Item", async () => {
    const seeded = await seed("openai-compatible");
    const fake = fakeLlm("openai-compatible", [{ json: valid }]);

    await callAgent({
      db,
      encryptionKey,
      workspaceId: seeded.workspaceId,
      modelConfig: seeded.modelConfig,
      itemId: null,
      purpose: "compile-rule",
      schema,
      system: "You compile rules.",
      prompt: "Compile this rule.",
      fetch: fake.fetch,
    });

    expect(await rows(seeded)).toMatchObject([{ itemId: null, purpose: "compile-rule", status: "ok" }]);
  });
});
