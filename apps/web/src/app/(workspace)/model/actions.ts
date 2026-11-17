"use server";

import { redirect } from "next/navigation";
import {
  applyDetectedPrices,
  type ModelInput,
  modelFormValues,
  type PriceProblem,
  removeModel,
  saveModel,
  testConnection,
  testModelSettings,
} from "@/lib/model";
import { keepSentBack } from "@/lib/sent-back";
import { requireWorkspace, server } from "@/lib/server";
import { isRecord } from "@watchdog/shared/utils/is-record";
import { revalidatePath } from "next/cache";
import { checkModelPrices, listModelChoices, type ModelListOutcome, type PriceCheck } from "@/lib/model-list";

// Every action ends in a redirect, as on Sources. The page reads the outcome from the URL, and what
// the form held after a refusal or a test from a cookie, because a link can't set one (#134).

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

/** What a form posts, as the Model screen's fields name it. */
const modelInput = (formData: FormData): ModelInput => ({
  providerType: text(formData, "providerType"),
  baseUrl: text(formData, "baseUrl"),
  modelName: text(formData, "modelName"),
  apiKey: text(formData, "apiKey"),
  clearKey: formData.get("clearKey") !== null,
  structured: formData.get("structured") !== null,
  inputPrice: text(formData, "inputPrice"),
  outputPrice: text(formData, "outputPrice"),
  pricesFromProvider: formData.get("pricesFromProvider") !== null,
});

/** Saves the model of the user's Workspace. A refusal goes back to the form, without the key. */
export async function saveModelAction(formData: FormData) {
  const { workspace } = await requireWorkspace();
  const input = modelInput(formData);
  const { db, encryptionKey } = server();
  const result = await saveModel(db, encryptionKey, workspace.id, input);
  if ("problem" in result) {
    await keepSentBack("/model", modelFormValues(input));
    redirect(`/model?${new URLSearchParams({ error: result.problem })}`);
  }
  redirect(result.keyLeftBehind ? "/model?saved=key-left-behind" : "/model?saved=1");
}

/** Calls the Workspace's saved model. The page reads why a call failed from its meter row. */
export async function testConnectionAction() {
  const { workspace } = await requireWorkspace();
  const { db, agentFetch, encryptionKey } = server();
  const outcome = await testConnection(db, { fetch: agentFetch, encryptionKey }, workspace.id);
  redirect(`/model?test=${outcome}`);
}

/**
 * Tests what the form holds without saving it, so a wrong address is found before it replaces the
 * working model. The values come back, without the key, as they do after a refusal.
 */
export async function testModelSettingsAction(formData: FormData) {
  const { workspace } = await requireWorkspace();
  const input = modelInput(formData);
  const { db, agentFetch, encryptionKey } = server();
  const result = await testModelSettings(db, { fetch: agentFetch, encryptionKey }, workspace.id, input);
  await keepSentBack("/model", modelFormValues(input));
  if ("problem" in result) redirect(`/model?${new URLSearchParams({ error: result.problem })}`);
  // The id names the row the call was metered against, where a failure's reason is. No call, no id.
  const id = result.modelConfigId === undefined ? {} : { formTestId: result.modelConfigId };
  redirect(`/model?${new URLSearchParams({ formTest: result.outcome, ...id })}`);
}

export async function removeModelAction() {
  const { workspace } = await requireWorkspace();
  await removeModel(server().db, workspace.id);
  redirect("/model?removed=1");
}

/** A field of the picker's posted object, as text: anything else is empty, which the schema refuses. */
const postedField = (value: unknown, name: string) => {
  if (!isRecord(value)) return "";
  const field = value[name];
  return typeof field === "string" ? field : "";
};

/**
 * The provider's model list for the Model form. The typed key travels in this POST's body, never a
 * URL, and the saved key is decrypted only here on the server. Nothing is saved or metered: a list is
 * not an Agent call.
 */
export async function listModelsAction(input: unknown): Promise<ModelListOutcome> {
  const { workspace } = await requireWorkspace();
  const { db, agentFetch, encryptionKey } = server();
  const posted = {
    providerType: postedField(input, "providerType"),
    baseUrl: postedField(input, "baseUrl"),
    apiKey: postedField(input, "apiKey"),
  };
  return listModelChoices(db, { fetch: agentFetch, encryptionKey }, workspace.id, posted);
}

/** Re-reads the saved model's prices from the provider. It saves nothing until the user confirms. */
export async function checkPricesAction(): Promise<PriceCheck> {
  const { workspace } = await requireWorkspace();
  const { db, agentFetch, encryptionKey } = server();
  return checkModelPrices(db, { fetch: agentFetch, encryptionKey }, workspace.id);
}

/** Saves the prices a check found, once the user has seen both sets side by side. */
export async function applyPricesAction(input: unknown): Promise<{ problem: PriceProblem } | { saved: true }> {
  const { workspace } = await requireWorkspace();
  const result = await applyDetectedPrices(server().db, workspace.id, {
    inputPrice: postedField(input, "inputPrice"),
    outputPrice: postedField(input, "outputPrice"),
  });
  if ("saved" in result) revalidatePath("/model");
  return result;
}
