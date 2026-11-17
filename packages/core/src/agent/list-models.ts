// Each provider family's own models endpoint, for the Model screen's picker (GitHub issue #488).
// Separate from `callAgent`: no prompt, no retry, no `agent_call` row, and nothing metered.
import { perMillion } from "@watchdog/shared/utils/cost";
import { isRecord } from "@watchdog/shared/utils/is-record";
import { z } from "zod";
import { EgressBlockedError } from "../egress/egress.ts";
import type { AgentFetch } from "./provider.ts";

/** As many models as the picker holds. A provider that pages is read to here, never unbounded. */
export const maxListedModels = 1000;

/** The form's own limit on a model name, so a listed id can always be saved. */
const maxModelIdLength = 200;

/** Why a list didn't load, as a code the screen turns into a sentence. */
export type ModelListFailure =
  | "unauthorized"
  | "rate-limited"
  | "provider-error"
  | "blocked"
  | "unreachable"
  | "no-endpoint"
  | "bad-response";

/**
 * One model, with the price its provider published for it. Only OpenRouter publishes prices in its
 * list; every other family leaves both null, and the form keeps them manual.
 */
export interface ListedModel {
  id: string;
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
}

export type ModelListResult = { ok: true; models: ListedModel[] } | { ok: false; reason: ModelListFailure };

export interface ModelListConfig {
  providerType: "openai-compatible" | "anthropic" | "google";
  /** Without a trailing slash, as a saved model keeps it. */
  baseUrl: string;
}

/**
 * The OpenAI and Anthropic shape: ids under `data`, and Anthropic's page cursor alongside. OpenRouter
 * adds `pricing` per entry, in USD per token as decimal strings; nothing else in the list is read.
 */
const dataPage = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      // Read by `priced` only on OpenRouter: a host that sends a number, null or anything else must
      // still list its models, since the price is an extra and never the reason to refuse a list.
      pricing: z.unknown().optional(),
    }),
  ),
  has_more: z.boolean().optional(),
  last_id: z.string().nullish(),
});

/** Gemini names a model `models/<id>`, filtered to the ones it can answer with. */
const googlePage = z.object({
  models: z.array(
    z.object({
      name: z.string().min(1),
      supportedGenerationMethods: z.array(z.string()).optional(),
    }),
  ),
  nextPageToken: z.string().optional(),
});

type Fetched = { ok: true; body: unknown } | { ok: false; reason: ModelListFailure };

const failed = (reason: ModelListFailure): ModelListResult => ({ ok: false, reason });

/** A refused credential is its own case: the user has to change the key, not the address. */
function failureForStatus(status: number): ModelListFailure {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404 || status === 405 || status === 501) return "no-endpoint";
  // A host asking us to slow down, or one that broke, isn't a malformed list: say what it is.
  if (status === 429) return "rate-limited";
  if (status >= 500) return "provider-error";
  return "bad-response";
}

/**
 * One GET, read as JSON. An address the guard refuses is `blocked`, and any other failure to reach
 * the host is `unreachable`: neither reached the provider, so neither is its answer.
 */
async function getJson(fetch: AgentFetch, url: URL, headers: Record<string, string>): Promise<Fetched> {
  let response: Awaited<ReturnType<AgentFetch>>;
  try {
    response = await fetch(url, { headers });
  } catch (error) {
    return { ok: false, reason: error instanceof EgressBlockedError ? "blocked" : "unreachable" };
  }
  if (!response.ok) {
    // The guard holds a skipped body's socket until the timeout, so release it.
    await response.body?.cancel();
    return { ok: false, reason: failureForStatus(response.status) };
  }
  try {
    const body: unknown = await response.json();
    return { ok: true, body };
  } catch {
    return { ok: false, reason: "bad-response" };
  }
}

/**
 * A name the Model form could save: trimmed, non-empty, and no longer than the field's limit. A NUL
 * or half a surrogate pair is refused, as the form refuses it, so the picker never offers a name the
 * save would then reject.
 */
function usableId(name: string) {
  const id = name.trim();
  if (id === "" || id.length > maxModelIdLength || id.includes("\0") || !id.isWellFormed()) return undefined;
  return id;
}

/** Sorts the ids and holds the list to its bound once, whichever page they came from. */
function finish(models: ListedModel[]): ModelListResult {
  const sorted = [...models].sort((a, b) => (a.id < b.id ? -1 : 1));
  return { ok: true, models: sorted.slice(0, maxListedModels) };
}

/** Fills to the bound, keeping the first entry of an id a host lists twice. */
function collect(models: ListedModel[], entries: ListedModel[]) {
  const seen = new Set(models.map(({ id }) => id));
  for (const entry of entries) {
    if (models.length >= maxListedModels) return;
    const id = usableId(entry.id);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    models.push({ ...entry, id });
  }
}

/** One field of a host's pricing object, when it really is a string. */
function priceText(entry: { pricing?: unknown }, field: "prompt" | "completion") {
  if (!isRecord(entry.pricing)) return undefined;
  const value = entry.pricing[field];
  return typeof value === "string" ? value : undefined;
}

/** A price as a number, or null for anything that isn't a decimal string: a price is never guessed. */
function pricePerMillion(perToken: string | undefined): number | null {
  if (perToken === undefined) return null;
  const text = perToken.trim();
  if (!/^\d*\.?\d+(?:[eE][-+]?\d+)?$/.test(text)) return null;
  const price = Number(perMillion(text));
  return Number.isFinite(price) && price >= 0 ? price : null;
}

/** OpenRouter is the one family Watchdog supports that publishes prices in its models response. */
function publishesPrices(baseUrl: string) {
  try {
    const { hostname } = new URL(baseUrl);
    return hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

/** OpenAI, OpenRouter, Groq, DeepSeek, Ollama and any other host that speaks this shape. */
async function openAiCompatibleModels(
  baseUrl: string,
  apiKey: string | null,
  fetch: AgentFetch,
): Promise<ModelListResult> {
  const url = new URL(`${baseUrl}/models`);
  const headers: Record<string, string> = { accept: "application/json" };
  // A local model may have no key. A blank Authorization would be a key the provider reads as wrong.
  if (apiKey !== null && apiKey !== "") headers.authorization = `Bearer ${apiKey}`;

  const fetched = await getJson(fetch, url, headers);
  if (!fetched.ok) return failed(fetched.reason);
  const parsed = dataPage.safeParse(fetched.body);
  if (!parsed.success) return failed("bad-response");
  const priced = publishesPrices(url.origin);
  const models: ListedModel[] = [];
  collect(
    models,
    parsed.data.data.map((entry) => ({
      id: entry.id,
      inputPricePerMillion: priced ? pricePerMillion(priceText(entry, "prompt")) : null,
      outputPricePerMillion: priced ? pricePerMillion(priceText(entry, "completion")) : null,
    })),
  );
  return finish(models);
}

/** Anthropic pages with `after_id` and `has_more`, so the bound is met page by page. */
async function anthropicModels(baseUrl: string, apiKey: string | null, fetch: AgentFetch): Promise<ModelListResult> {
  const headers: Record<string, string> = { accept: "application/json", "anthropic-version": "2023-06-01" };
  if (apiKey !== null && apiKey !== "") headers["x-api-key"] = apiKey;

  const models: ListedModel[] = [];
  let after: string | undefined;
  // The cap is the real bound; this only stops a host that keeps claiming another page.
  for (let page = 0; page < 10; page++) {
    const url = new URL(`${baseUrl}/models`);
    url.searchParams.set("limit", String(maxListedModels));
    if (after !== undefined) url.searchParams.set("after_id", after);

    const fetched = await getJson(fetch, url, headers);
    if (!fetched.ok) return failed(fetched.reason);
    const parsed = dataPage.safeParse(fetched.body);
    if (!parsed.success) return failed("bad-response");
    collect(
      models,
      parsed.data.data.map(({ id }) => ({ id, inputPricePerMillion: null, outputPricePerMillion: null })),
    );
    const last = parsed.data.last_id;
    if (parsed.data.has_more !== true || typeof last !== "string" || last === "" || models.length >= maxListedModels) {
      break;
    }
    after = last;
  }
  return finish(models);
}

/** Gemini's list carries every method a model supports, so the chat-capable ones are picked out. */
async function googleModels(baseUrl: string, apiKey: string | null, fetch: AgentFetch): Promise<ModelListResult> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey !== null && apiKey !== "") headers["x-goog-api-key"] = apiKey;

  const models: ListedModel[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const url = new URL(`${baseUrl}/models`);
    url.searchParams.set("pageSize", String(maxListedModels));
    if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);

    const fetched = await getJson(fetch, url, headers);
    if (!fetched.ok) return failed(fetched.reason);
    const parsed = googlePage.safeParse(fetched.body);
    if (!parsed.success) return failed("bad-response");
    collect(
      models,
      parsed.data.models
        // `model_config.model_name` holds the bare id, so the prefix never reaches the field.
        .filter((model) => model.supportedGenerationMethods?.includes("generateContent") === true)
        .map(({ name }) => ({
          id: name.startsWith("models/") ? name.slice("models/".length) : name,
          inputPricePerMillion: null,
          outputPricePerMillion: null,
        })),
    );
    if (
      parsed.data.nextPageToken === undefined ||
      parsed.data.nextPageToken === "" ||
      models.length >= maxListedModels
    ) {
      break;
    }
    pageToken = parsed.data.nextPageToken;
  }
  return finish(models);
}

/**
 * The models the provider's own endpoint lists for this key, or a typed failure. The key is sent in
 * the provider's own header and only to the configured base URL. Nothing is written: a list is not
 * an Agent call, so it makes no `agent_call` row and changes no saved model (ADR 0008).
 */
export function listModels(config: ModelListConfig, apiKey: string | null, fetch: AgentFetch): Promise<ModelListResult> {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  switch (config.providerType) {
    case "openai-compatible":
      return openAiCompatibleModels(baseUrl, apiKey, fetch);
    case "anthropic":
      return anthropicModels(baseUrl, apiKey, fetch);
    case "google":
      return googleModels(baseUrl, apiKey, fetch);
  }
}
