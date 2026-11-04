// One model configuration to one AI SDK model (ADR 0005, ADR 0016).
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { modelConfig } from "@watchdog/db";
import type { Config } from "../config.ts";
import { createEgressFetch } from "../egress/egress.ts";

export type AgentModelConfig = typeof modelConfig.$inferSelect;

/** The egress guard's fetch, which every Agent request goes through. */
export type AgentFetch = ReturnType<typeof createEgressFetch>;

/** A fetch for Agent calls. Local models can take longer than the guard's default 30 seconds. */
export function createAgentFetch(config: Pick<Config, "mode" | "egressAllowlist">): AgentFetch {
  return createEgressFetch(config, { timeoutMs: 120_000 });
}

// The guard's fetch uses undici's types, and the providers want the global fetch's. An Agent call
// sends a JSON string and doesn't stream, so the response can be read whole.
function providerFetch(fetch: AgentFetch): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await fetch(input instanceof Request ? input.url : input, {
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: typeof init?.body === "string" ? init.body : null,
      signal: init?.signal ?? null,
    });
    return new Response(response.body === null ? null : await response.arrayBuffer(), {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers),
    });
  };
}

/**
 * The model and the options that apply the "supports structured output" flag. Without the flag,
 * OpenAI-compatible and Google hosts get plain JSON mode, which sends no schema, so the prompt has
 * to carry it. Anthropic has no such mode. It answers through a forced tool call that carries the
 * schema, which is how ADR 0016 says it works.
 */
export function createAgentModel(config: AgentModelConfig, apiKey: string | null, fetch: AgentFetch) {
  const structured = config.supportsStructuredOutput;
  const settings = { baseURL: config.baseUrl, fetch: providerFetch(fetch) };
  // With no key, these two providers read ANTHROPIC_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY from the
  // environment. An empty key keeps an operator's key from going to a user's base URL.
  const key = apiKey ?? "";
  switch (config.providerType) {
    case "openai-compatible":
      return {
        model: createOpenAICompatible({
          ...settings,
          name: "openai-compatible",
          supportsStructuredOutputs: structured,
          ...(apiKey !== null && { apiKey }),
        })(config.modelName),
        providerOptions: {},
        schemaInPrompt: !structured,
      };
    case "anthropic":
      return {
        model: createAnthropic({ ...settings, apiKey: key })(config.modelName),
        providerOptions: {
          anthropic: { structuredOutputMode: structured ? "outputFormat" : "jsonTool" },
        },
        schemaInPrompt: false,
      };
    case "google":
      return {
        model: createGoogle({ ...settings, apiKey: key })(config.modelName),
        providerOptions: { google: { structuredOutputs: structured } },
        schemaInPrompt: !structured,
      };
  }
}
