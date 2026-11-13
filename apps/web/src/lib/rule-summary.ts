// What a rule does, in one line, for its row in the Rules list: two rules of one kind can then be told
// apart without opening either. The full text is on the rule's own page.
import { type Classifier, conditionToWords, type ExtractorRule, ruleSchema } from "@watchdog/core";

/** A rule's definition as its row shows it: a line, or that the rule no longer runs. */
export type RuleSummary = { text: string } | { unreadable: true };

/**
 * The most a row shows before its line is shortened. A rule's row is 343 px wide at 390 px of
 * viewport, which holds about 45 characters of `text-sm` on a line, so this is two lines at phone
 * width and one at desktop width. Opening the rule shows all of it.
 */
export const maxSummaryLength = 120;

/**
 * The line cut to `maxSummaryLength`, on a word where one is near enough the end. A long regex or URL
 * has no space to cut at, so it is cut where it is rather than left to widen the page.
 */
function shortened(text: string) {
  if (text.length <= maxSummaryLength) return text;
  const head = text.slice(0, maxSummaryLength);
  // A cut at a code unit can leave half a surrogate pair at the end, which renders as a replacement
  // character; dropping it costs one code unit of the line.
  const intact = head.isWellFormed() ? head : head.slice(0, -1);
  const space = intact.lastIndexOf(" ");
  const cut = space > maxSummaryLength / 2 ? intact.slice(0, space) : intact;
  // A comma or space left at the end would read as the line trailing off, not as it being cut, and a
  // joiner with nothing after it reads as a mistake, so the cut moves back over it.
  const line = cut.replace(/[\s,;:]+$/u, "").replace(/\s+(?:and|or)$/u, "");
  return `${line}…`;
}

/** The names a rule writes, in the order it writes them. */
const words = (names: string[]) => names.join(", ");

/**
 * A Condition, then what the rule writes from it, which is what two rules of one kind differ in. An
 * Agent-backed Classifier has no Condition: its prompt decides, and all it states is what it may
 * assign.
 */
function summaryOf(rule: Classifier | ExtractorRule) {
  if ("classifier" in rule) {
    return "prompt" in rule
      ? `May assign ${words(rule.categories)}`
      : `${conditionToWords(rule.when)} → ${words(rule.assign)}`;
  }
  return `${conditionToWords(rule.when)} → ${words(rule.fields.map(({ name }) => name))}`;
}

/**
 * What the row says about the rule stored under `definition`. A definition that no longer parses gets
 * no summary: the pipeline skips that rule, so a row that only listed nothing would still look healthy.
 */
export function ruleSummary(definition: unknown): RuleSummary {
  const parsed = ruleSchema.safeParse(definition);
  // An Action's row shows its own detail. A Classifier's or Extractor Rule's table holding one is a
  // rule the pipeline can't run either, so the row says its definition doesn't parse.
  if (!parsed.success || "action" in parsed.data) return { unreadable: true };
  return { text: shortened(summaryOf(parsed.data)) };
}
