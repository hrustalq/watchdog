"use server";

import { redirect } from "next/navigation";
import { isMap, type RuleProblem, yamlWithoutScript } from "@/lib/rule-draft";
import { isRuleType, removeRule, type RuleTarget, saveRule, setRuleEnabled } from "@/lib/rules";
import { requireWorkspace, server } from "@/lib/server";

export interface SaveState {
  problems: RuleProblem[];
}

// Bound arguments come back from the client, so they're checked here and against the Workspace.
const asTarget = (value: unknown): RuleTarget | undefined =>
  isMap(value) && isRuleType(value.type) && typeof value.id === "string"
    ? { type: value.type, id: value.id }
    : undefined;

// A URL this long is safe through Caddy and Node, whose limit on all the headers is 16 KB.
const maxDraftInUrl = 6000;

/** Where a browser without JavaScript goes to see what was wrong: the page checks the draft again. */
function editorWithDraft(target: RuleTarget | null, draft: string) {
  const path = target === null ? "/rules/new" : `/rules/${target.type}/${target.id}`;
  const query = new URLSearchParams({ draft }).toString();
  return query.length > maxDraftInUrl ? `${path}?draft-too-long=1` : `${path}?${query}`;
}

/**
 * Saves the draft as a rule of the user's Workspace. With JavaScript, a refusal returns to the
 * editor, which keeps the draft. Without it, a returned value would leave a blank page, so every
 * outcome is a redirect.
 */
export async function saveRuleAction(
  boundTarget: unknown,
  _previous: SaveState,
  formData: FormData,
): Promise<SaveState> {
  const { workspace } = await requireWorkspace();
  const target = boundTarget === null ? null : asTarget(boundTarget);
  if (target === undefined) redirect("/rules");

  const withoutScript = formData.get(yamlWithoutScript);
  const posted = typeof withoutScript === "string" ? withoutScript : formData.get("yaml");
  const yaml = typeof posted === "string" ? posted : "";

  const result = await saveRule(server().db, workspace.id, target, yaml);
  if ("saved" in result) redirect("/rules?saved=1");
  if (typeof withoutScript === "string") redirect(editorWithDraft(target, yaml));
  return { problems: result.problems };
}

/** An id outside the user's Workspace changes nothing. */
export async function setRuleEnabledAction(type: unknown, id: unknown, enabled: unknown) {
  const { workspace } = await requireWorkspace();
  if (isRuleType(type) && typeof id === "string" && typeof enabled === "boolean") {
    await setRuleEnabled(server().db, workspace.id, type, id, enabled);
  }
  redirect("/rules");
}

/** An id outside the user's Workspace changes nothing. */
export async function removeRuleAction(type: unknown, id: unknown) {
  const { workspace } = await requireWorkspace();
  if (isRuleType(type) && typeof id === "string") {
    await removeRule(server().db, workspace.id, type, id);
  }
  redirect("/rules");
}
