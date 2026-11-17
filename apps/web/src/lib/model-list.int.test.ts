import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createAgentFetch } from "@watchdog/core";
import {
  agentCall,
  closeDb,
  createDb,
  type Db,
  eq,
  migrate,
  modelConfig,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listModelChoices, type ModelListDeps } from "./model-list.ts";
import { type ModelInput, saveModel } from "./model.ts";

const encryptionKey = Buffer.alloc(32, 7);
const storedKey = "sk-stored-key";
const allow = [{ type: "subnet", address: "127.0.0.1", prefix: 32, family: "ipv4" }] as const;

/** A provider that lists two models and keeps the Authorization header each request carried. */
async function modelServer() {
  const seen: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    seen.push(request.headers.authorization);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "gpt-5" }, { id: "gpt-5-mini" }] }));
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a port");
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    seen,
    stop: () =>
      new Promise<void>((closed) => {
        server.closeAllConnections();
        server.close(() => {
          closed();
        });
      }),
  };
}

const input = (overrides: Partial<ModelInput> = {}): ModelInput => ({
  providerType: "openai-compatible",
  baseUrl: "https://llm.test/v1",
  modelName: "fake-model",
  apiKey: "",
  clearKey: false,
  structured: false,
  inputPrice: "",
  outputPrice: "",
  ...overrides,
});

describe("the Model screen's model list", () => {
  let db: Db;
  let postgres: Awaited<ReturnType<typeof startPostgres>>;

  beforeAll(async () => {
    postgres = await startPostgres();
    await migrate(postgres.url);
    db = createDb(postgres.url);
  }, 120_000);

  afterAll(async () => {
    await closeDb(db);
    await postgres.stop();
  });

  async function newWorkspace() {
    const id = crypto.randomUUID();
    await db.insert(user).values({ id, name: "Owner", email: `${id}@example.com` });
    const [row] = await db.insert(workspace).values({ name: "Workspace", ownerUserId: id }).returning();
    if (row === undefined) throw new Error("Expected a Workspace");
    return row.id;
  }

  async function saveModelAt(workspaceId: string, baseUrl: string, apiKey: string) {
    const result = await saveModel(db, encryptionKey, workspaceId, input({ baseUrl, apiKey }));
    if ("problem" in result) throw new Error(`Expected a save, got ${result.problem}`);
  }

  const deps = (): ModelListDeps => ({
    encryptionKey,
    fetch: createAgentFetch({ mode: "self-hosted", egressAllowlist: [...allow] }),
  });

  it("uses the saved key on the same provider and origin, and writes no agent_call row", async () => {
    const workspaceId = await newWorkspace();
    const server = await modelServer();
    try {
      await saveModelAt(workspaceId, server.baseUrl, storedKey);

      const outcome = await listModelChoices(db, deps(), workspaceId, {
        providerType: "openai-compatible",
        baseUrl: server.baseUrl,
        apiKey: "",
      });

      expect(outcome).toEqual({ ok: true, models: [{ id: "gpt-5" }, { id: "gpt-5-mini" }] });
      expect(server.seen).toEqual([`Bearer ${storedKey}`]);
      // Listing isn't an Agent call: no meter row, and the saved model is untouched.
      const calls = await db.select().from(agentCall).where(eq(agentCall.workspaceId, workspaceId));
      expect(calls).toEqual([]);
      const [saved] = await db.select().from(modelConfig).where(eq(modelConfig.workspaceId, workspaceId));
      expect(saved?.modelName).toBe("fake-model");
      expect(saved?.archivedAt).toBeNull();
    } finally {
      await server.stop();
    }
  });

  it("never sends the saved key to another origin, and uses the typed key when there is one", async () => {
    const workspaceId = await newWorkspace();
    const saved = await modelServer();
    const other = await modelServer();
    try {
      await saveModelAt(workspaceId, saved.baseUrl, storedKey);

      const untyped = await listModelChoices(db, deps(), workspaceId, {
        providerType: "openai-compatible",
        baseUrl: other.baseUrl,
        apiKey: "",
      });
      expect(untyped.ok).toBe(true);
      expect(other.seen).toEqual([undefined]);

      const typed = await listModelChoices(db, deps(), workspaceId, {
        providerType: "openai-compatible",
        baseUrl: other.baseUrl,
        apiKey: "sk-typed",
      });
      expect(typed.ok).toBe(true);
      expect(other.seen).toEqual([undefined, "Bearer sk-typed"]);
      expect(saved.seen).toEqual([]);
    } finally {
      await saved.stop();
      await other.stop();
    }
  });

  it("takes the typed key over the saved one at the same address", async () => {
    const workspaceId = await newWorkspace();
    const server = await modelServer();
    try {
      await saveModelAt(workspaceId, server.baseUrl, storedKey);

      await listModelChoices(db, deps(), workspaceId, {
        providerType: "openai-compatible",
        baseUrl: server.baseUrl,
        apiKey: "sk-typed",
      });

      expect(server.seen).toEqual(["Bearer sk-typed"]);
    } finally {
      await server.stop();
    }
  });

  it("says the saved key is unreadable rather than sending nothing as if it were refused", async () => {
    const workspaceId = await newWorkspace();
    const server = await modelServer();
    try {
      await saveModelAt(workspaceId, server.baseUrl, storedKey);

      const outcome = await listModelChoices(
        db,
        { encryptionKey: Buffer.alloc(32, 9), fetch: deps().fetch },
        workspaceId,
        { providerType: "openai-compatible", baseUrl: server.baseUrl, apiKey: "" },
      );

      expect(outcome).toEqual({ ok: false, reason: "unreadable-key" });
      expect(server.seen).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it("uses a typed key even while the saved one can't be read, so a rotated key never blocks a paste", async () => {
    const workspaceId = await newWorkspace();
    const server = await modelServer();
    try {
      await saveModelAt(workspaceId, server.baseUrl, storedKey);

      const outcome = await listModelChoices(
        db,
        { encryptionKey: Buffer.alloc(32, 9), fetch: deps().fetch },
        workspaceId,
        { providerType: "openai-compatible", baseUrl: server.baseUrl, apiKey: "sk-typed" },
      );

      expect(outcome.ok).toBe(true);
      expect(server.seen).toEqual(["Bearer sk-typed"]);
    } finally {
      await server.stop();
    }
  });

  it("refuses a base URL the form would refuse, without any request", async () => {
    const workspaceId = await newWorkspace();
    const server = await modelServer();
    try {
      const outcome = await listModelChoices(db, deps(), workspaceId, {
        providerType: "nope",
        baseUrl: server.baseUrl,
        apiKey: "",
      });

      expect(outcome).toEqual({ ok: false, reason: "invalid-input" });
      expect(server.seen).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it("says blocked when the egress guard refuses the address", async () => {
    const workspaceId = await newWorkspace();
    const outcome = await listModelChoices(
      db,
      { encryptionKey, fetch: createAgentFetch({ mode: "hosted", egressAllowlist: [] }) },
      workspaceId,
      { providerType: "openai-compatible", baseUrl: "http://169.254.169.254/v1", apiKey: "" },
    );

    expect(outcome).toEqual({ ok: false, reason: "blocked" });
  });

  it("keeps the random key material out of the model list's answer", async () => {
    const workspaceId = await newWorkspace();
    const server = await modelServer();
    try {
      const key = randomBytes(24).toString("hex");
      await saveModelAt(workspaceId, server.baseUrl, key);

      const outcome = await listModelChoices(db, deps(), workspaceId, {
        providerType: "openai-compatible",
        baseUrl: server.baseUrl,
        apiKey: "",
      });

      expect(JSON.stringify(outcome)).not.toContain(key);
    } finally {
      await server.stop();
    }
  });
});
