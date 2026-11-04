// What the Rules screen calls things, in the glossary's terms.
import type { RuleKind } from "@/lib/rule-draft";

export const kindLabel: Record<RuleKind, string> = { deterministic: "Deterministic", agent: "Agent-backed" };
export const appliesFromNow = "A saved rule applies to Items captured from now on. Past Items aren't reprocessed.";
export const modelLink = "/model";
export const kindsExplained =
  "A deterministic rule runs tests you write. An Agent-backed rule follows a prompt, and needs a model.";
