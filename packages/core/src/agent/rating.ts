// What the extract-and-rate call asks for (docs: Agent and LLM integration, "Calls per Item" and
// "Rating scale").
import { z } from "zod";
import type { AgentExtractorRule } from "../rules/schema.ts";
import { storableText } from "./call-agent.ts";

const anchors = `Severity, how urgent or harmful the Item is:
5: act today, e.g. an outage, or a security advisory in something the user depends on.
4: act this week, e.g. a serious bug, or a breaking change about to reach the user.
3: plan for it this month, e.g. a bug with a workaround, or a deprecation with a date.
2: minor, with no deadline, e.g. a cosmetic bug or a small complaint.
1: nothing urgent or harmful, e.g. a feature request, a competitor's launch, or routine news.

Importance, how much the Item matters to the user:
5: directly about the user's product, or a key competitor or customer.
4: about something else the Profile names, e.g. another competitor, a dependency or a tracked market.
3: about the user's field in general, and useful to know, e.g. a trend or a product in an adjacent space.
2: only loosely related, e.g. general news that touches one of the user's interests.
1: unrelated to anything in the Profile, e.g. off-topic posts or spam.`;

// Blank as stored, since storing drops what Postgres refuses.
const text = z.string().refine((value) => storableText(value).trim() !== "", "This can't be blank.");
const level = z.int().min(1).max(5);

// In this order, so a model that answers in schema order gives its reasons before its Rating.
const ratingShape = { summary: text, reasoning: text, severity: level, importance: level };

// Stays flat when the Item doesn't contain a field: null or empty is a valid answer (ADR 0016).
const fieldTypes = {
  string: z.string().nullable(),
  integer: z.int().nullable(),
  "string-array": z.array(z.string()).nullable(),
  "integer-array": z.array(z.int()).nullable(),
};

/** A rule can name a field `summary` or `severity`, and the schema is one flat object. */
export const fieldKey = (name: string) => `field_${name}`;

function fieldShape(rules: readonly AgentExtractorRule[]) {
  const fields: Record<string, z.ZodType> = {};
  for (const { name, type } of rules.flatMap((rule) => rule.fields)) {
    fields[fieldKey(name)] ??= fieldTypes[type];
  }
  return fields;
}

/**
 * The flat output schema for one Item, from the rules whose Condition it meets. Its type names only the
 * fixed keys, because a rule's keys exist only at run time. A field two rules declare keeps the oldest
 * rule's type, as an Item keeps the oldest rule's value.
 */
export function ratingSchema(rules: readonly AgentExtractorRule[]) {
  const shape: typeof ratingShape = { ...ratingShape, ...fieldShape(rules) };
  return z.object(shape);
}

/** The flat output schema for a manual run: one rule's fields, with no Rating or summary. */
export const manualRunSchema = (rule: AgentExtractorRule) => z.object(fieldShape([rule]));

const asExtractionJson = (rules: readonly AgentExtractorRule[]) =>
  JSON.stringify(
    rules.map((rule) => ({
      rule: rule.extractor,
      instructions: rule.prompt,
      keys: rule.fields.map(({ name, type }) => ({ key: fieldKey(name), type })),
    })),
  );

/** What a manual run has to do, for the system message. */
export const manualRunTask = (rule: AgentExtractorRule) =>
  `Answer each key of this Extractor Rule, following its instructions. A key the Item has no value for
is null.

Extractor Rule, as JSON:
${asExtractionJson([rule])}`;

/** What this call has to do, for the system message. The rules' prompts go here: the user wrote them. */
export function ratingTask(rules: readonly AgentExtractorRule[], outputLanguage: string) {
  return `Rate the Item and summarise it, and answer with these keys:
- summary: what the Item says, in a sentence or two.
- reasoning: why it gets this Rating, in a sentence or two.
- severity: a level from 1 to 5, using the scale below.
- importance: a level from 1 to 5, using the scale below.

Write the summary and the reasoning in the language with the ISO 639-1 code ${JSON.stringify(outputLanguage)},
whatever language the Item is in.

${anchors}

Judge importance against the Profile. Use the Corrections as examples of how the user judges Items.${
    rules.length === 0
      ? ""
      : `

Also answer each key of these Extractor Rules, following each rule's instructions. A key the Item has
no value for is null.

Extractor Rules, as JSON:
${asExtractionJson(rules)}`
  }`;
}
