import { Headers, Response } from "undici";
import { describe, expect, it } from "vitest";
import { EgressBlockedError } from "../egress/egress.ts";
import { listModels, maxListedModels } from "./list-models.ts";
import type { AgentFetch } from "./provider.ts";

interface Requested {
  url: URL;
  headers: Headers;
}

/** A fetch that answers from a fixture and keeps what it was asked for. */
function fakeFetch(handler: (url: URL, headers: Headers) => Response) {
  const requested: Requested[] = [];
  const fetch: AgentFetch = (input, init) => {
    const url = new URL(input instanceof URL ? input.href : input);
    const headers = new Headers(init?.headers);
    requested.push({ url, headers });
    return Promise.resolve(handler(url, headers));
  };
  return { fetch, requested };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ids = (models: { id: string }[]) => models.map(({ id }) => id);

describe("listing a provider's models", () => {
  describe("an OpenAI-compatible host", () => {
    it("reads GET /models with a bearer key, and deduplicates and sorts the ids", async () => {
      const { fetch, requested } = fakeFetch(() =>
        json({ data: [{ id: "gpt-5-mini" }, { id: "gpt-5" }, { id: "gpt-5-mini" }] }),
      );

      const result = await listModels({ providerType: "openai-compatible", baseUrl: "https://llm.test/v1" }, "sk-test", fetch);

      expect(result.ok && ids(result.models)).toEqual(["gpt-5", "gpt-5-mini"]);
      expect(requested[0]?.url.href).toBe("https://llm.test/v1/models");
      expect(requested[0]?.headers.get("authorization")).toBe("Bearer sk-test");
    });

    it("sends no Authorization header when the model has no key", async () => {
      const { fetch, requested } = fakeFetch(() => json({ data: [{ id: "llama3" }] }));

      await listModels({ providerType: "openai-compatible", baseUrl: "http://localhost:11434/v1/" }, null, fetch);

      expect(requested[0]?.headers.has("authorization")).toBe(false);
      expect(requested[0]?.url.href).toBe("http://localhost:11434/v1/models");
    });

    it("gives up at the list's bound rather than reading every page a host offers", async () => {
      const many = Array.from({ length: maxListedModels + 500 }, (_value, index) => ({ id: `model-${String(index)}` }));
      const { fetch } = fakeFetch(() => json({ data: many }));

      const result = await listModels({ providerType: "openai-compatible", baseUrl: "https://llm.test/v1" }, "k", fetch);

      expect(result.ok && result.models).toHaveLength(maxListedModels);
    });
  });

  describe("Anthropic", () => {
    it("reads GET /models with its own headers, and follows after_id while has_more says to", async () => {
      const pages = [
        json({ data: [{ id: "claude-sonnet-4-6" }], has_more: true, last_id: "claude-sonnet-4-6" }),
        json({ data: [{ id: "claude-haiku-4-5" }], has_more: false }),
      ];
      const { fetch, requested } = fakeFetch(() => {
        const page = pages.shift();
        if (page === undefined) throw new Error("Asked for a page the fixture doesn't have");
        return page;
      });

      const result = await listModels({ providerType: "anthropic", baseUrl: "https://api.anthropic.com/v1" }, "sk-ant", fetch);

      expect(result.ok && ids(result.models)).toEqual(["claude-haiku-4-5", "claude-sonnet-4-6"]);
      expect(requested[0]?.headers.get("x-api-key")).toBe("sk-ant");
      expect(requested[0]?.headers.get("anthropic-version")).toBe("2023-06-01");
      expect(requested[0]?.headers.has("authorization")).toBe(false);
      expect(requested[0]?.url.searchParams.get("limit")).toBe(String(maxListedModels));
      expect(requested[1]?.url.searchParams.get("after_id")).toBe("claude-sonnet-4-6");
    });

    it("stops when has_more is true but the page names no cursor, rather than looping", async () => {
      const { fetch, requested } = fakeFetch(() => json({ data: [{ id: "claude-sonnet-4-6" }], has_more: true }));

      const result = await listModels({ providerType: "anthropic", baseUrl: "https://api.anthropic.com/v1" }, "k", fetch);

      expect(result.ok && ids(result.models)).toEqual(["claude-sonnet-4-6"]);
      expect(requested).toHaveLength(1);
    });
  });

  describe("Google Gemini", () => {
    it("reads GET /models with the key in x-goog-api-key, keeps chat models, and strips models/", async () => {
      const { fetch, requested } = fakeFetch(() =>
        json({
          models: [
            { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent", "countTokens"] },
            { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
            { name: "gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
          ],
          nextPageToken: "",
        }),
      );

      const result = await listModels(
        { providerType: "google", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
        "goog-key",
        fetch,
      );

      expect(result.ok && ids(result.models)).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);
      expect(requested[0]?.headers.get("x-goog-api-key")).toBe("goog-key");
      expect(requested[0]?.url.searchParams.get("pageSize")).toBe(String(maxListedModels));
    });

    it("follows a nextPageToken", async () => {
      const pages = [
        json({ models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }], nextPageToken: "next" }),
        json({ models: [{ name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] }] }),
      ];
      const { fetch, requested } = fakeFetch(() => {
        const page = pages.shift();
        if (page === undefined) throw new Error("Asked for a page the fixture doesn't have");
        return page;
      });

      const result = await listModels({ providerType: "google", baseUrl: "https://google.test/v1beta" }, "k", fetch);

      expect(result.ok && ids(result.models)).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);
      expect(requested[1]?.url.searchParams.get("pageToken")).toBe("next");
    });
  });

  describe("OpenRouter's prices", () => {
    it("converts each per-token price to per-million, keeping zero and dropping a malformed one", async () => {
      const { fetch } = fakeFetch(() =>
        json({
          data: [
            { id: "cheap", pricing: { prompt: "0.00000015", completion: "0.0000006" } },
            { id: "free", pricing: { prompt: "0", completion: "0" } },
            { id: "unpriced" },
            { id: "bad", pricing: { prompt: "not a price", completion: "0.000001" } },
          ],
        }),
      );

      const result = await listModels(
        { providerType: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1" },
        "k",
        fetch,
      );

      expect(result.ok && result.models).toEqual([
        { id: "bad", inputPricePerMillion: null, outputPricePerMillion: 1 },
        { id: "cheap", inputPricePerMillion: 0.15, outputPricePerMillion: 0.6 },
        { id: "free", inputPricePerMillion: 0, outputPricePerMillion: 0 },
        { id: "unpriced", inputPricePerMillion: null, outputPricePerMillion: null },
      ]);
    });

    it("still lists the models when a host's pricing isn't the strings it expected", async () => {
      const { fetch } = fakeFetch(() =>
        json({ data: [{ id: "gpt-5", pricing: { prompt: 0.0001, completion: null } }] }),
      );

      const result = await listModels({ providerType: "openai-compatible", baseUrl: "https://llm.test/v1" }, "k", fetch);

      expect(result.ok && ids(result.models)).toEqual(["gpt-5"]);
    });

    it("never takes a price from another host that happens to send pricing", async () => {
      const { fetch } = fakeFetch(() =>
        json({ data: [{ id: "gpt-5", pricing: { prompt: "0.0001", completion: "0.0002" } }] }),
      );

      const result = await listModels({ providerType: "openai-compatible", baseUrl: "https://llm.test/v1" }, "k", fetch);

      expect(result.ok && result.models).toEqual([
        { id: "gpt-5", inputPricePerMillion: null, outputPricePerMillion: null },
      ]);
    });

    it("leaves a chat provider's prices null even when its response carries them", async () => {
      const { fetch } = fakeFetch(() =>
        json({
          models: [
            {
              name: "models/gemini-2.5-flash",
              supportedGenerationMethods: ["generateContent"],
              pricing: { prompt: "0.1", completion: "0.2" },
            },
          ],
        }),
      );

      const result = await listModels(
        { providerType: "google", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
        "k",
        fetch,
      );

      expect(result.ok && result.models).toEqual([
        { id: "gemini-2.5-flash", inputPricePerMillion: null, outputPricePerMillion: null },
      ]);
    });
  });

  describe("failures", () => {
    it("calls a refused key unauthorized, not a broken response", async () => {
      const { fetch } = fakeFetch(() => json({ error: "no" }, 401));

      const result = await listModels({ providerType: "openai-compatible", baseUrl: "https://llm.test/v1" }, "k", fetch);

      expect(result).toEqual({ ok: false, reason: "unauthorized" });
    });

    it("calls a missing endpoint no-endpoint, so the screen can offer manual entry", async () => {
      const { fetch } = fakeFetch(() => json({}, 404));

      const result = await listModels({ providerType: "openai-compatible", baseUrl: "https://llm.test/v1" }, "k", fetch);

      expect(result).toEqual({ ok: false, reason: "no-endpoint" });
    });

    it("rejects a response that isn't the shape the provider documents", async () => {
      const { fetch } = fakeFetch(() => json({ models: [{ id: "wrong-key" }] }));

      const result = await listModels({ providerType: "openai-compatible", baseUrl: "https://llm.test/v1" }, "k", fetch);

      expect(result).toEqual({ ok: false, reason: "bad-response" });
    });

    it("rejects a body that isn't JSON at all", async () => {
      const { fetch } = fakeFetch(() => new Response("<html>not here</html>", { status: 200 }));

      const result = await listModels({ providerType: "openai-compatible", baseUrl: "https://llm.test/v1" }, "k", fetch);

      expect(result).toEqual({ ok: false, reason: "bad-response" });
    });

    it("names a rate limit and a provider error, rather than blaming the list's shape", async () => {
      const limited = fakeFetch(() => json({}, 429));
      const broken = fakeFetch(() => json({}, 503));

      await expect(
        listModels({ providerType: "openai-compatible", baseUrl: "https://llm.test/v1" }, "k", limited.fetch),
      ).resolves.toEqual({ ok: false, reason: "rate-limited" });
      await expect(
        listModels({ providerType: "openai-compatible", baseUrl: "https://llm.test/v1" }, "k", broken.fetch),
      ).resolves.toEqual({ ok: false, reason: "provider-error" });
    });

    it("drops a name the Model form would refuse, such as one holding a NUL", async () => {
      const { fetch } = fakeFetch(() =>
        json({ data: [{ id: "ok-model" }, { id: `bad${String.fromCharCode(0)}name` }] }),
      );

      const result = await listModels({ providerType: "openai-compatible", baseUrl: "https://llm.test/v1" }, "k", fetch);

      expect(result.ok && ids(result.models)).toEqual(["ok-model"]);
    });

    it("says blocked when the egress guard refused the address", async () => {
      const { fetch } = fakeFetch(() => {
        throw new EgressBlockedError("llm.test", "it resolves to the blocked address 10.0.0.1");
      });

      const result = await listModels({ providerType: "openai-compatible", baseUrl: "https://llm.test/v1" }, "k", fetch);

      expect(result).toEqual({ ok: false, reason: "blocked" });
    });

    it("says unreachable when the host can't be reached at all", async () => {
      const { fetch } = fakeFetch(() => {
        throw new TypeError("fetch failed");
      });

      const result = await listModels({ providerType: "openai-compatible", baseUrl: "https://llm.test/v1" }, "k", fetch);

      expect(result).toEqual({ ok: false, reason: "unreachable" });
    });
  });
});
