// What the Rules screen calls things, in the glossary's terms.
import type { RuleKind, RuleType } from "@/lib/rule-draft";

export const ruleNoun: Record<RuleType, string> = { classifier: "Classifier", extractor: "Extractor Rule" };
export const kindLabel: Record<RuleKind, string> = { deterministic: "Deterministic", agent: "Agent-backed" };
export const appliesFromNow = "A saved rule applies to Items captured from now on. Past Items aren't reprocessed.";
export const modelLink = "/model";
