// The Agent interface, the only code that calls a model (Agent and LLM integration). It validates
// every response, repairs an invalid one once, and meters every attempt (ADR 0008, ADR 0016).
import { agentCall, type Db } from "@watchdog/db";
import {
  APICallError,
  generateText,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  TypeValidationError,
} from "ai";
import { z } from "zod";
import { EgressBlockedError } from "../egress/egress.ts";
import { decryptSecret } from "../secrets/secrets.ts";
import { type AgentFetch, type AgentModelConfig, createAgentModel } from "./provider.ts";

// The SDK warns on every call that a host without the flag gets no schema, which is intended.
globalThis.AI_SDK_LOG_WARNINGS = false;

export interface AgentFailure {
  ok: false;
  reason: "invalid_output" | "blocked" | "error";
  message: string;
}
export type AgentResult<Value> = { ok: true; output: Value } | AgentFailure;

export interface CallAgentOptions<Schema extends z.ZodObject> {
  db: Db;
  modelConfig: AgentModelConfig;
  /** Decrypts the model's API key for this call. */
  encryptionKey: Buffer;
  workspaceId: string;
  /** Null when the call isn't about an Item, as when compiling a rule. */
  itemId: string | null;
  purpose: (typeof agentCall.$inferInsert)["purpose"];
  /** A flat object: strings, integers, enums and arrays of those (ADR 0016). */
  schema: Schema;
  system: string;
  prompt: string;
  /** From `createAgentFetch`. */
  fetch: AgentFetch;
}

const asPlainJson = (schema: z.ZodObject) =>
  `Respond with only a JSON object that matches this JSON Schema, with no other text:
${JSON.stringify(z.toJSONSchema(schema))}`;

const asRepair = (prompt: string, problem: string) =>
  `${prompt}

Your previous response failed validation. Respond again with only the JSON, with no code fences or
other text, and fix this:
${problem}`;

const maxInteger = 2_147_483_647;
/** A host can report any number, and one the column refuses mustn't lose a paid answer. */
const storableTokens = (count: number | undefined) =>
  count !== undefined && Number.isInteger(count) && count >= 0 && count <= maxInteger ? count : null;

/** Postgres refuses a NUL and half a surrogate pair, and a provider's error can hold either. */
const storableMessage = (message: string) => message.replaceAll("\0", "").toWellFormed().slice(0, 1000);

const rowStatus = { invalid_output: "invalid_output", blocked: "error", error: "error" } as const;

function validationError(error: NoObjectGeneratedError | NoOutputGeneratedError) {
  if (NoOutputGeneratedError.isInstance(error)) return "The response was empty.";
  const cause = TypeValidationError.isInstance(error.cause) ? error.cause.cause : error.cause;
  return cause instanceof z.ZodError ? z.prettifyError(cause) : "The response was not valid JSON.";
}

function describeFailure(error: unknown) {
  if (APICallError.isInstance(error) && error.statusCode !== undefined) {
    return `The model provider answered ${String(error.statusCode)}: ${error.message}`;
  }
  // The SDK reports no answer at all (DNS, a refused connection, TLS) with no status.
  if (APICallError.isInstance(error)) return `Watchdog couldn't reach the model provider: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** Returns validated output or a typed failure. It throws only when it can't write the meter row. */
export async function callAgent<Schema extends z.ZodObject>(
  options: CallAgentOptions<Schema>,
): Promise<AgentResult<z.output<Schema>>> {
  const { db, modelConfig, schema, system, prompt } = options;

  // The meter's foreign key would catch this too, but only after the model has been paid for.
  if (options.workspaceId !== modelConfig.workspaceId) {
    return { ok: false, reason: "error", message: "This model belongs to another Workspace." };
  }

  let prepared;
  try {
    const ciphertext = modelConfig.apiKeyCiphertext;
    // Headers drop surrounding whitespace, so trimming redacts the key as the provider receives it.
    const apiKey = ciphertext === null ? null : decryptSecret(ciphertext, options.encryptionKey).trim();
    const agentModel = createAgentModel(modelConfig, apiKey, options.fetch);
    const instructions = agentModel.schemaInPrompt ? `${system}\n\n${asPlainJson(schema)}` : system;
    prepared = { apiKey, instructions, ...agentModel };
  } catch (error) {
    return { ok: false, reason: "error", message: describeFailure(error) };
  }
  const { apiKey, instructions, model, providerOptions } = prepared;
  // A provider's error can quote the key it was sent, and the message may reach a Log row.
  const redact = (text: string) =>
    apiKey === null || apiKey === "" ? text : text.replaceAll(apiKey, "[redacted]");

  async function attempt(number: number, text: string) {
    const started = performance.now();
    let usage;
    let result: AgentResult<z.output<Schema>>;
    try {
      const response = await generateText({
        model,
        providerOptions,
        instructions,
        prompt: text,
        output: Output.object<z.output<Schema>>({ schema }),
        // pg-boss alone retries, so no attempt goes unmetered.
        maxRetries: 0,
      });
      ({ usage } = response);
      result = { ok: true, output: response.output };
    } catch (error) {
      if (NoObjectGeneratedError.isInstance(error) || NoOutputGeneratedError.isInstance(error)) {
        usage = NoObjectGeneratedError.isInstance(error) ? error.usage : usage;
        result = { ok: false, reason: "invalid_output", message: validationError(error) };
      } else {
        const reason = error instanceof EgressBlockedError ? "blocked" : "error";
        result = { ok: false, reason, message: describeFailure(error) };
      }
    }
    if (!result.ok) result = { ...result, message: redact(result.message) };

    await db.insert(agentCall).values({
      workspaceId: options.workspaceId,
      modelConfigId: modelConfig.id,
      itemId: options.itemId,
      purpose: options.purpose,
      attempt: number,
      inputTokens: storableTokens(usage?.inputTokens),
      outputTokens: storableTokens(usage?.outputTokens),
      latencyMs: Math.round(performance.now() - started),
      status: result.ok ? "ok" : rowStatus[result.reason],
      errorMessage: result.ok ? null : storableMessage(result.message),
    });
    return result;
  }

  const first = await attempt(1, prompt);
  if (first.ok || first.reason !== "invalid_output") return first;
  return attempt(2, asRepair(prompt, first.message));
}

/** One small real call, so the user knows the model works. It costs a few tokens and is metered. */
export function testModelConnection(
  options: Pick<CallAgentOptions<z.ZodObject>, "db" | "modelConfig" | "encryptionKey" | "fetch">,
) {
  return callAgent({
    ...options,
    workspaceId: options.modelConfig.workspaceId,
    itemId: null,
    purpose: "test-connection",
    // Any string counts: this tests the connection, not how well the model follows instructions.
    schema: z.object({ reply: z.string() }),
    system: "You are answering a connection test.",
    prompt: 'Set "reply" to "ok".',
  });
}
