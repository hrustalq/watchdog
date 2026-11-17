// The picker's list, decided on the server: which key may be sent where, and what a failure says.
import { type AgentFetch, listModels, readApiKey } from "@watchdog/core";
import { and, type Db, eq, isNull, modelConfig } from "@watchdog/db";
import { type ModelListInput, parseModelList } from "./model.ts";

/** Why a list didn't load, as a code the field turns into a sentence. */
export type ModelListReason =
  | "invalid-input"
  | "unreadable-key"
  | "unauthorized"
  | "blocked"
  | "unreachable"
  | "no-endpoint"
  | "bad-response";

export type ModelListOutcome = { ok: true; models: { id: string }[] } | { ok: false; reason: ModelListReason };

export interface ModelListDeps {
  /** From `createAgentFetch`. */
  fetch: AgentFetch;
  encryptionKey: Buffer;
}

/**
 * The provider's own model list for the form. A typed key wins. The stored key goes only to the
 * provider type and origin the saved model already has, which is when saving would keep it: a stored
 * key must never travel to another host, or a session could read it by pointing the base URL at its
 * own server. Nothing is written, so no `agent_call` row is made and the saved model is unchanged.
 */
export async function listModelChoices(
  db: Db,
  deps: ModelListDeps,
  workspaceId: string,
  input: ModelListInput,
): Promise<ModelListOutcome> {
  const parsed = parseModelList(input);
  if ("problem" in parsed) return { ok: false, reason: "invalid-input" };

  const saved = await db.query.modelConfig.findFirst({
    where: and(eq(modelConfig.workspaceId, workspaceId), isNull(modelConfig.archivedAt)),
    columns: { providerType: true, baseUrl: true, apiKeyCiphertext: true },
  });
  const sameDestination =
    saved !== undefined &&
    saved.providerType === parsed.providerType &&
    new URL(saved.baseUrl).origin === new URL(parsed.baseUrl).origin;
  // An unreadable stored key would go as no key and look like a refused one, so the screen says why.
  let stored: string | null | undefined = null;
  if (saved !== undefined && sameDestination) stored = readApiKey(saved.apiKeyCiphertext, deps.encryptionKey);
  if (stored === undefined) return { ok: false, reason: "unreadable-key" };

  return listModels(
    { providerType: parsed.providerType, baseUrl: parsed.baseUrl },
    parsed.apiKey === "" ? stored : parsed.apiKey,
    deps.fetch,
  );
}
