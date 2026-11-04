"use server";

import { redirect } from "next/navigation";
import { type ModelInput, modelFormQuery, removeModel, saveModel, testConnection } from "@/lib/model";
import { requireWorkspace, server } from "@/lib/server";

// Every action ends in a redirect, as on Sources, and the page reads the outcome from the URL.

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

/** Saves the model of the user's Workspace. A refusal goes back to the form, without the key. */
export async function saveModelAction(formData: FormData) {
  const { workspace } = await requireWorkspace();
  const input: ModelInput = {
    providerType: text(formData, "providerType"),
    baseUrl: text(formData, "baseUrl"),
    modelName: text(formData, "modelName"),
    apiKey: text(formData, "apiKey"),
    structured: formData.get("structured") !== null,
    inputPrice: text(formData, "inputPrice"),
    outputPrice: text(formData, "outputPrice"),
  };
  const { db, encryptionKey } = server();
  const result = await saveModel(db, encryptionKey, workspace.id, input);
  if ("problem" in result) redirect(`/model?${modelFormQuery(result.problem, input).toString()}`);
  redirect(result.keyLeftBehind ? "/model?saved=key-left-behind" : "/model?saved=1");
}

/** Calls the Workspace's saved model. The page reads why a call failed from its meter row. */
export async function testConnectionAction() {
  const { workspace } = await requireWorkspace();
  const { db, agentFetch, encryptionKey } = server();
  const outcome = await testConnection(db, { fetch: agentFetch, encryptionKey }, workspace.id);
  redirect(`/model?test=${outcome}`);
}

export async function removeModelAction() {
  const { workspace } = await requireWorkspace();
  await removeModel(server().db, workspace.id);
  redirect("/model?removed=1");
}
