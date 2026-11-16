// What the Rules screen calls things, in the glossary's terms.
import type { ActionKind, RuleKind } from "@/lib/rule-draft";

export const kindLabel: Record<RuleKind | ActionKind, string> = {
  deterministic: "Deterministic",
  agent: "Agent-backed",
  alert: "Alert",
  webhook: "Webhook",
  digest: "Digest",
};
export const appliesFromNow = "A saved rule applies to Items captured from now on. Past Items aren't reprocessed.";
export const actionApplies =
  "A saved Action applies to Items captured from now on and fires at most once per Item. Past Items aren't reprocessed.";
export const modelLink = "/model";
export const destinationsLink = "/destinations";
export const waitingForConfirmation = (names: string[]) =>
  `Won't deliver to ${names.join(", ")} until ${names.length === 1 ? "it's" : "they're"} confirmed.`;
export const kindsExplained =
  "A Classifier or Extractor Rule is deterministic, running tests you write, or Agent-backed, following a prompt and needing a model.";
