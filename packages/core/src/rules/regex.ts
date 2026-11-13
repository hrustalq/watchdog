// Rule regexes (docs: Rule model, "Regular expressions"; ADR 0026). The only module that touches
// the engine, so changing engines means changing this file.
import { RE2JS } from "re2js";
// Types only: schema.ts imports this module, so importing it back would be a runtime cycle.
import type { Condition, Rule } from "./schema.ts";

// Match time is input length × program size, so linear time alone doesn't protect the worker.
const maxInstructions = 1000;

/**
 * How many instructions a pattern that passed `regexError` compiles to. Match time is input length
 * times this, so it's what a Workspace's rule budget spends (docs: Rule model, "Limits on a rule").
 */
export function patternInstructions(pattern: string): number {
  return RE2JS.compile(pattern).programSize();
}

/** Every pattern a Condition runs, in the order it tests them. */
function* patternsIn(condition: Condition): Generator<string> {
  // Walking the tree here rather than through schema.ts's `predicates`: see the type-only import.
  if ("all" in condition) {
    for (const child of condition.all) yield* patternsIn(child);
  } else if ("any" in condition) {
    for (const child of condition.any) yield* patternsIn(child);
  } else if ("not" in condition) {
    yield* patternsIn(condition.not);
  } else if (condition.op === "matches") {
    yield condition.value;
  }
}

/**
 * How many instructions a rule's regexes compile to in total: every `matches` predicate in its
 * Condition and every regex field. A Workspace's hosted budget sums this over its enabled rules,
 * because capping the number of rules leaves up to 50 regexes in each one (ADR 0026, GitHub #100).
 */
export function ruleInstructions(rule: Rule): number {
  let total = 0;
  if ("when" in rule) {
    for (const pattern of patternsIn(rule.when)) total += patternInstructions(pattern);
  }
  if ("extractor" in rule) {
    for (const field of rule.fields) {
      if ("regex" in field) total += patternInstructions(field.regex);
    }
  }
  return total;
}

/** Why a rule can't use this regex, or undefined when it can. */
export function regexError(pattern: string): string | undefined {
  try {
    if (RE2JS.compile(pattern).programSize() <= maxInstructions) return undefined;
  } catch (error) {
    return `"${pattern}" isn't a regular expression Watchdog can run: ${error instanceof Error ? error.message : String(error)}`;
  }
  return `"${pattern}" is too complex: it compiles to more than ${String(maxInstructions)} instructions.`;
}

/** Why a rule can't extract a field with this regex, or undefined when it can. */
export function captureRegexError(pattern: string): string | undefined {
  const error = regexError(pattern);
  if (error !== undefined) return error;
  return RE2JS.compile(pattern).groupCount() > 0
    ? undefined
    : `"${pattern}" has no capture group, so it can't extract a value.`;
}

/** Whether a validated pattern matches anywhere in the text. */
export function regexMatches(pattern: string, text: string) {
  return RE2JS.compile(pattern).test(text);
}

/** The first capture group of the first match of a validated pattern, if there is one. */
export function firstCapture(pattern: string, text: string) {
  const matcher = RE2JS.compile(pattern).matcher(text);
  return matcher.find() ? (matcher.group(1) ?? undefined) : undefined;
}

/** The text with every match of a validated pattern removed. */
export function withoutMatches(pattern: string, text: string) {
  return RE2JS.compile(pattern).matcher(text).replaceAll("");
}
