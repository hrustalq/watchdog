// A fake model behind the provider's `fetch` option, so tests run the real provider code with no
// network and no model bill (Testing and CI, "Rules for tests"). Answers use each family's wire format.
import type { modelConfig } from "@watchdog/db";
import { Headers, type RequestInit, Response } from "undici";

type Usage = { inputTokens: number; outputTokens: number } | null;

/** One scripted answer. Whether `json` is schema-valid is up to the test. */
export type FakeTurn =
  /** The model answers with this JSON value. `usage: null` leaves the usage block out. */
  | { json: unknown; usage?: Usage }
  /** The model answers with this text, such as something that isn't JSON. */
  | { text: string; usage?: Usage }
  /** The model declines to answer: a content filter, and no text. */
  | { refused: true }
  /** The provider answers with an HTTP error. */
  | { status: number; message?: string };

export interface FakeRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const defaultUsage = { inputTokens: 10, outputTokens: 5 };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Without the structured output flag, the Anthropic provider asks through a tool of this name. */
const hasJsonTool = (body: unknown) =>
  isRecord(body) &&
  Array.isArray(body.tools) &&
  body.tools.some((tool) => isRecord(tool) && tool.name === "json");

const openAiCompatibleMessage = (content: string | null, finishReason: string, usage: Usage) => ({
  id: "fake",
  object: "chat.completion",
  created: 0,
  model: "fake",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
  ...(usage && {
    usage: {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens + usage.outputTokens,
    },
  }),
});

const anthropicMessage = (content: unknown[], stopReason: string, usage: Usage) => ({
  id: "fake",
  type: "message",
  role: "assistant",
  model: "fake",
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  ...(usage && { usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens } }),
});

const googleMessage = (parts: unknown[], finishReason: string, usage: Usage) => ({
  candidates: [{ index: 0, content: { role: "model", parts }, finishReason }],
  ...(usage && {
    usageMetadata: {
      promptTokenCount: usage.inputTokens,
      candidatesTokenCount: usage.outputTokens,
      totalTokenCount: usage.inputTokens + usage.outputTokens,
    },
  }),
});

const families = {
  "openai-compatible": {
    answer: (text: string, usage: Usage) => openAiCompatibleMessage(text, "stop", usage),
    refusal: () => openAiCompatibleMessage(null, "content_filter", defaultUsage),
    error: (message: string) => ({ error: { message, type: "server_error" } }),
  },
  anthropic: {
    answer: (text: string, usage: Usage) =>
      anthropicMessage([{ type: "text", text }], "end_turn", usage),
    refusal: () => anthropicMessage([], "refusal", defaultUsage),
    error: (message: string) => ({ type: "error", error: { type: "api_error", message } }),
  },
  google: {
    answer: (text: string, usage: Usage) => googleMessage([{ text }], "STOP", usage),
    refusal: () => googleMessage([], "SAFETY", defaultUsage),
    error: (message: string) => ({ error: { code: 500, message, status: "INTERNAL" } }),
  },
};

/**
 * A fake model that gives `turns` in order and records each request. A request after the last turn
 * throws, so a test can't make more calls than it scripted without noticing.
 */
export function fakeLlm(
  providerType: (typeof modelConfig.$inferSelect)["providerType"],
  turns: FakeTurn[],
) {
  const family = families[providerType];
  const remaining = [...turns];
  const requests: FakeRequest[] = [];

  function wire(turn: FakeTurn, body: unknown) {
    if ("status" in turn) return family.error(turn.message ?? "The fake model failed");
    if ("refused" in turn) return family.refusal();
    const usage = turn.usage === undefined ? defaultUsage : turn.usage;
    if ("text" in turn) return family.answer(turn.text, usage);
    if (providerType === "anthropic" && hasJsonTool(body)) {
      const toolUse = { type: "tool_use", id: "fake", name: "json", input: turn.json };
      return anthropicMessage([toolUse], "tool_use", usage);
    }
    return family.answer(JSON.stringify(turn.json), usage);
  }

  const fetch = (input: string | URL, init: RequestInit = {}) => {
    const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : null;
    requests.push({ url: String(input), headers: Object.fromEntries(new Headers(init.headers)), body });
    const turn = remaining.shift();
    if (turn === undefined) throw new Error(`The fake model got an unscripted request: ${String(input)}`);
    return Promise.resolve(
      new Response(JSON.stringify(wire(turn, body)), {
        status: "status" in turn ? turn.status : 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  return { requests, fetch };
}
