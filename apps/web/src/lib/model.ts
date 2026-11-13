// A Workspace's model, as the Model screen reads and changes it (ADR 0005). Every query is scoped to
// the Workspace, and nothing here returns the key or its ciphertext to the page.
import { type AgentFetch, encryptSecret, readApiKey, testModelConnection } from "@watchdog/core";
import {
  agentCall,
  and,
  type Db,
  desc,
  eq,
  isNotNull,
  isNull,
  modelConfig,
  type SQL,
  sql,
  type Tx,
  workspace,
} from "@watchdog/db";
import { isUuid } from "./uuid.ts";

export const providerTypes = [
  { value: "openai-compatible", label: "OpenAI-compatible", baseUrl: "https://api.openai.com/v1" },
  { value: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com/v1" },
  { value: "google", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
] as const;

export interface ModelDeps {
  /** From `createAgentFetch`. */
  fetch: AgentFetch;
  encryptionKey: Buffer;
}

/** What the form posts, as text. */
export interface ModelInput {
  providerType: string;
  baseUrl: string;
  modelName: string;
  /** Blank keeps the current key, for as long as the model stays on the same provider and origin. */
  apiKey: string;
  /** "Remove the stored key", which deletes the key while the row stays. It takes a blank key field. */
  clearKey: boolean;
  structured: boolean;
  inputPrice: string;
  outputPrice: string;
}

/** Why a model wasn't saved, as a code the form can carry in its URL. Each names the field it's about. */
export const modelProblems = [
  "provider",
  "base-url",
  "model-name",
  "api-key",
  "input-price",
  "output-price",
] as const;
export type ModelProblem = (typeof modelProblems)[number];

export const modelProblemMessage: Record<ModelProblem, string> = {
  provider: "Choose one of the provider types in the list.",
  "base-url": "Enter the full base URL, starting with http:// or https://, with no user name or query.",
  "model-name": "Enter the model's name as the provider spells it, in at most 200 characters.",
  "api-key": "An API key is one line of letters, digits and symbols, and at most 4096 characters.",
  "input-price": "Enter a price per million tokens as a number, such as 2.50, or leave it blank.",
  "output-price": "Enter a price per million tokens as a number, such as 2.50, or leave it blank.",
};

const webUrl = (text: string) => {
  const url = URL.parse(text.trim());
  return url !== null && (url.protocol === "http:" || url.protocol === "https:") ? url : undefined;
};

/** Without a trailing slash, an address has one spelling to compare. */
const address = (url: URL) => `${url.origin}${url.pathname}`.replace(/\/+$/, "");

/** A URL this long is safe through Caddy and Node, whose limit on all the headers is 16 KB. */
const maxBaseUrlInUrl = 2000;

/**
 * The form's URL after a refusal. The key never goes in a URL, so the form asks for it again. Nor
 * does anything else that can hold one: people paste keys into a base URL's user name or query.
 */
export function modelFormQuery(problem: ModelProblem, input: ModelInput) {
  const url = webUrl(input.baseUrl);
  const baseUrl = url === undefined ? "" : address(url);
  const query = new URLSearchParams({
    error: problem,
    providerType: input.providerType,
    baseUrl: baseUrl.length > maxBaseUrlInUrl ? "" : baseUrl,
    modelName: input.modelName,
    inputPrice: input.inputPrice,
    outputPrice: input.outputPrice,
  });
  if (input.structured) query.set("structured", "1");
  if (input.clearKey) query.set("clearKey", "1");
  if (input.apiKey.trim() !== "") query.set("keyTyped", "1");
  return query;
}

/**
 * The SDKs append their own path, so a query would end up in the middle of the URL, and fetch
 * refuses a URL with credentials. An empty `?` or `#` isn't refused: `search` and `hash` don't show
 * it, and `address` drops it.
 */
function cleanBaseUrl(text: string) {
  const url = webUrl(text);
  const usable = url?.username === "" && url.password === "" && url.search === "" && url.hash === "";
  return usable ? address(url) : undefined;
}

/** Null for a blank price, undefined for one that isn't a price. */
function cleanPrice(text: string) {
  if (text.trim() === "") return null;
  const price = Number(text);
  return Number.isFinite(price) && price >= 0 ? price : undefined;
}

function parseModel(input: ModelInput) {
  const provider = providerTypes.find(({ value }) => value === input.providerType)?.value;
  if (provider === undefined) return { problem: "provider" } as const;
  const baseUrl = cleanBaseUrl(input.baseUrl);
  if (baseUrl === undefined) return { problem: "base-url" } as const;
  const modelName = input.modelName.trim();
  // Postgres text refuses a NUL and half a surrogate pair.
  if (modelName === "" || modelName.length > 200 || modelName.includes("\0") || !modelName.isWellFormed()) {
    return { problem: "model-name" } as const;
  }
  const apiKey = input.apiKey.trim();
  // Anything else can't go in a header, and fails on every call.
  if (apiKey !== "" && !/^[\x21-\x7e]{1,4096}$/.test(apiKey)) return { problem: "api-key" } as const;
  // One or the other: a key typed beside the box is a user who wants both, and saving would drop one.
  if (apiKey !== "" && input.clearKey) return { problem: "api-key" } as const;
  const inputPrice = cleanPrice(input.inputPrice);
  if (inputPrice === undefined) return { problem: "input-price" } as const;
  const outputPrice = cleanPrice(input.outputPrice);
  if (outputPrice === undefined) return { problem: "output-price" } as const;
  return { provider, baseUrl, modelName, apiKey, inputPrice, outputPrice };
}

/**
 * What a save does to the stored key: a typed key replaces it, the box removes it, and a blank field
 * with neither keeps it.
 */
function keyChange(newCiphertext: string | null, clearKey: boolean) {
  if (newCiphertext !== null) return { apiKeyCiphertext: newCiphertext };
  if (clearKey) return { apiKeyCiphertext: null };
  return {};
}

/**
 * Changes to a Workspace's model take turns. Otherwise two saves could both replace the same row,
 * and a save could put a key back on a row a removal just archived.
 */
const takeTurns = (tx: Pick<Tx, "select">, workspaceId: string) =>
  tx.select({ id: workspace.id }).from(workspace).where(eq(workspace.id, workspaceId)).for("no key update");

/**
 * Creates the Workspace's model or changes it. A new provider, base URL or model name is a new row,
 * and the old one is archived, so Usage history keeps pointing at what ran. Prices, the flag and the
 * key change in place.
 *
 * A blank key keeps the current one, except on the way to another provider or origin: the key was
 * only ever meant for the old one. `keyLeftBehind` says that happened. Blank with the box ticked
 * clears the key and keeps the row, so what ran under it still says so.
 */
export async function saveModel(
  db: Db,
  encryptionKey: Buffer,
  workspaceId: string,
  input: ModelInput,
): Promise<{ problem: ModelProblem } | { keyLeftBehind: boolean }> {
  const parsed = parseModel(input);
  if (parsed.problem !== undefined) return { problem: parsed.problem };
  const { provider, baseUrl, modelName, apiKey, inputPrice, outputPrice } = parsed;
  const newCiphertext = apiKey === "" ? null : encryptSecret(apiKey, encryptionKey);
  const settings = {
    supportsStructuredOutput: input.structured,
    inputPricePerMillion: inputPrice,
    outputPricePerMillion: outputPrice,
  };

  return db.transaction(async (tx) => {
    await takeTurns(tx, workspaceId);
    const [current] = await tx
      .select()
      .from(modelConfig)
      .where(and(eq(modelConfig.workspaceId, workspaceId), isNull(modelConfig.archivedAt)));

    if (
      current?.providerType === provider &&
      current.baseUrl === baseUrl &&
      current.modelName === modelName
    ) {
      // Only a typed key or the box touches the key: a blank field on its own keeps it.
      await tx
        .update(modelConfig)
        .set({ ...settings, ...keyChange(newCiphertext, input.clearKey) })
        .where(eq(modelConfig.id, current.id));
      await fillCallPrices(tx, current.id, settings);
      return { keyLeftBehind: false };
    }

    const sameDestination =
      current?.providerType === provider && new URL(current.baseUrl).origin === new URL(baseUrl).origin;
    // The box is an ask for the key to be gone, which a new row mustn't undo by carrying it over.
    const carried = sameDestination && !input.clearKey ? current.apiKeyCiphertext : null;
    await archiveModel(tx, workspaceId);
    await tx.insert(modelConfig).values({
      workspaceId,
      providerType: provider,
      baseUrl,
      modelName,
      apiKeyCiphertext: newCiphertext ?? carried,
      ...settings,
    });
    const hadKey = (current?.apiKeyCiphertext ?? null) !== null;
    return { keyLeftBehind: !input.clearKey && hadKey && newCiphertext === null && carried === null };
  });
}

/**
 * Gives the calls that recorded no prices this model's prices, so a user who sets them after the
 * Agent has already run still gets an estimate for what ran. A call that recorded a price keeps it:
 * that is what it cost. Half a price can't make an estimate, so this waits for both.
 */
async function fillCallPrices(
  db: Pick<Tx, "update">,
  modelConfigId: string,
  prices: { inputPricePerMillion: number | null; outputPricePerMillion: number | null },
) {
  const { inputPricePerMillion, outputPricePerMillion } = prices;
  if (inputPricePerMillion === null || outputPricePerMillion === null) return;
  await db
    .update(agentCall)
    .set({ inputPricePerMillion, outputPricePerMillion })
    .where(
      and(
        eq(agentCall.modelConfigId, modelConfigId),
        isNull(agentCall.inputPricePerMillion),
        isNull(agentCall.outputPricePerMillion),
      ),
    );
}

/** An archived row only has to say what ran, so it forgets the key. False when there's no model. */
async function archiveModel(db: Pick<Db, "update">, workspaceId: string) {
  const archived = await db
    .update(modelConfig)
    // The database's clock, which Item capture times use too, so the pipeline can compare them.
    .set({ archivedAt: sql`now()`, apiKeyCiphertext: null })
    .where(and(eq(modelConfig.workspaceId, workspaceId), isNull(modelConfig.archivedAt)))
    .returning({ id: modelConfig.id });
  return archived.length > 0;
}

/**
 * Archives the model, so Agent stages stop and Items stay unrated, while deterministic rules keep
 * running (Processing pipeline, "Without a model").
 */
export const removeModel = (db: Db, workspaceId: string) =>
  db.transaction(async (tx) => {
    await takeTurns(tx, workspaceId);
    return archiveModel(tx, workspaceId);
  });

/** What the Usage screen's form posts for a model it can't estimate: two prices, as text. */
export interface PriceInput {
  inputPrice: string;
  outputPrice: string;
}

/** Why an archived model's prices weren't saved. `model` is an id that isn't archived in this Workspace. */
export const priceProblems = ["input-price", "output-price", "model"] as const;
export type PriceProblem = (typeof priceProblems)[number];

// The two prices are the Model form's, so a refusal reads the same on either screen.
export const priceProblemMessage: Record<PriceProblem, string> = {
  "input-price": modelProblemMessage["input-price"],
  "output-price": modelProblemMessage["output-price"],
  model: "That model isn't an archived model in this Workspace, so nothing changed.",
};

/**
 * Prices an archived model, so the calls that ran before it had any get an estimate on the Usage
 * screen. Only the two prices change: the row stays archived, keeps whatever key it has, and can't
 * become the active model this way. Every archived row on the model's Usage line gets the prices,
 * because the screen shows one line for a model that ran more than once.
 */
export async function setArchivedPrices(
  db: Db,
  workspaceId: string,
  modelId: string,
  input: PriceInput,
): Promise<{ problem: PriceProblem } | { saved: true }> {
  const inputPrice = cleanPrice(input.inputPrice);
  if (inputPrice === undefined) return { problem: "input-price" } as const;
  const outputPrice = cleanPrice(input.outputPrice);
  if (outputPrice === undefined) return { problem: "output-price" } as const;
  // Postgres refuses a malformed uuid with an error rather than matching nothing.
  if (!isUuid(modelId)) return { problem: "model" } as const;

  return db.transaction(async (tx) => {
    const [line] = await tx
      .select({ providerType: modelConfig.providerType, baseUrl: modelConfig.baseUrl, modelName: modelConfig.modelName })
      .from(modelConfig)
      .where(
        and(eq(modelConfig.id, modelId), eq(modelConfig.workspaceId, workspaceId), isNotNull(modelConfig.archivedAt)),
      );
    if (line === undefined) return { problem: "model" } as const;
    const prices = { inputPricePerMillion: inputPrice, outputPricePerMillion: outputPrice };
    const priced = await tx
      .update(modelConfig)
      .set(prices)
      .where(
        and(
          eq(modelConfig.workspaceId, workspaceId),
          isNotNull(modelConfig.archivedAt),
          eq(modelConfig.providerType, line.providerType),
          eq(modelConfig.baseUrl, line.baseUrl),
          eq(modelConfig.modelName, line.modelName),
        ),
      )
      .returning({ id: modelConfig.id });
    // As saving the active model's prices does: calls that recorded none take these, so the estimate
    // covers what already ran rather than only the calls still to come. A recorded price stays.
    for (const row of priced) await fillCallPrices(tx, row.id, prices);
    return { saved: true } as const;
  });
}

export type StoredKey = "none" | "set" | "unreadable";

function storedKey(ciphertext: string | null, encryptionKey: Buffer): StoredKey {
  const apiKey = readApiKey(ciphertext, encryptionKey);
  if (apiKey === undefined) return "unreadable";
  return apiKey === null ? "none" : "set";
}

/**
 * The Workspace's model as the screen shows it, or undefined. It tries the key on every read, so a
 * changed WATCHDOG_ENCRYPTION_KEY shows before any call fails, and in a Workspace with no calls yet.
 */
export async function getModel(db: Db, encryptionKey: Buffer, workspaceId: string) {
  const [row] = await db
    .select({
      providerType: modelConfig.providerType,
      baseUrl: modelConfig.baseUrl,
      modelName: modelConfig.modelName,
      apiKeyCiphertext: modelConfig.apiKeyCiphertext,
      supportsStructuredOutput: modelConfig.supportsStructuredOutput,
      inputPricePerMillion: modelConfig.inputPricePerMillion,
      outputPricePerMillion: modelConfig.outputPricePerMillion,
    })
    .from(modelConfig)
    .where(and(eq(modelConfig.workspaceId, workspaceId), isNull(modelConfig.archivedAt)));
  if (row === undefined) return undefined;
  const { apiKeyCiphertext, ...model } = row;
  return { ...model, storedKey: storedKey(apiKeyCiphertext, encryptionKey) };
}

/**
 * Whether the active model's key can't be read, for the screens that would otherwise look healthy.
 * A Workspace with no model reads false, and so does a model with no key: neither is this problem.
 * It reads the key through `storedKey`, so there is one check, and it makes no call and records none.
 */
export async function hasUnreadableKey(db: Db, encryptionKey: Buffer, workspaceId: string) {
  const [row] = await db
    .select({ apiKeyCiphertext: modelConfig.apiKeyCiphertext })
    .from(modelConfig)
    .where(and(eq(modelConfig.workspaceId, workspaceId), isNull(modelConfig.archivedAt)));
  return row !== undefined && storedKey(row.apiKeyCiphertext, encryptionKey) === "unreadable";
}

/**
 * The active model's most recent failed call, or undefined. `recovered` means a call has worked
 * since, so the failure is history rather than something to fix.
 */
export async function lastFailedCall(db: Db, workspaceId: string) {
  const newest = (filter?: SQL) =>
    db
      .select({ at: agentCall.createdAt, status: agentCall.status, errorMessage: agentCall.errorMessage })
      .from(agentCall)
      .innerJoin(modelConfig, and(eq(agentCall.modelConfigId, modelConfig.id), isNull(modelConfig.archivedAt)))
      .where(and(eq(agentCall.workspaceId, workspaceId), filter))
      .orderBy(desc(agentCall.createdAt))
      .limit(1);
  // A literal, to match agent_call_failures_idx. A healthy model's history is never walked: without
  // a failure there's no second query, and with one this model's calls are near the newest.
  const [failed] = await newest(sql`${agentCall.status} <> 'ok'`);
  if (failed === undefined) return undefined;
  const [latest] = await newest();
  return {
    at: failed.at,
    reason: failed.errorMessage ?? "No reason was recorded.",
    recovered: latest?.status === "ok",
  };
}

export const testOutcomes = ["ok", "blocked", "failed", "unreadable-key", "no-model"] as const;
export type TestOutcome = (typeof testOutcomes)[number];

/**
 * Makes one small real call to the saved model. A call that was attempted leaves its reason on its
 * `agent_call` row, for `lastFailedCall`. An unreadable key makes no attempt, and `getModel` says so.
 */
export async function testConnection(db: Db, deps: ModelDeps, workspaceId: string): Promise<TestOutcome> {
  const [model] = await db
    .select()
    .from(modelConfig)
    .where(and(eq(modelConfig.workspaceId, workspaceId), isNull(modelConfig.archivedAt)));
  if (model === undefined) return "no-model";

  const result = await testModelConnection({
    db,
    modelConfig: model,
    encryptionKey: deps.encryptionKey,
    fetch: deps.fetch,
  });
  if (result.ok) return "ok";
  if (result.reason === "unreadable_key") return "unreadable-key";
  return result.reason === "blocked" ? "blocked" : "failed";
}
