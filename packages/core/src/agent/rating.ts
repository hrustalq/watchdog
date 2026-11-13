// What the extract-and-rate call asks for (docs: Agent and LLM integration, "Calls per Item" and
// "Rating scale").
import { z } from "zod";
import type { AgentExtractorRule } from "../rules/schema.ts";
import { storableText } from "./call-agent.ts";

/**
 * Who reads a line of the scale: the Agent's prompt, which names the user in the third person, or the
 * controls, which talk to that user.
 */
export type RatingReader = "agent" | "you";

/**
 * A line of the scale written for the reader, where it differs from the Agent's. It's a sentence of its
 * own and not a substitution: "something the user depends on" is "something you depend on", and swapping
 * one phrase for the other would give "something you depends on". A line that's missing here reads the
 * same to both.
 */
interface Addressed {
  about?: string;
  meaning?: string;
  example?: string;
}

/** One level: the wording the Agent reads, and the reader's own where that differs. */
interface RatingLevel {
  level: number;
  meaning: string;
  example?: string;
  you?: Addressed;
}

/** One axis: its name, what it's about, and its five levels. */
interface RatingAxisScale {
  name: string;
  about: string;
  you?: Addressed;
  levels: readonly RatingLevel[];
}

/** The axes, in the order the Agent's prompt and the guide that opens under the controls show them. */
export const ratingAxes = ["severity", "importance"] as const;

export type RatingAxis = (typeof ratingAxes)[number];

/** The one Rating scale: the Agent's prompt and the correction controls both read it. */
export const ratingScale: Record<RatingAxis, RatingAxisScale> = {
  severity: {
    name: "Severity",
    about: "how urgent or harmful the Item is",
    levels: [
      {
        level: 5,
        meaning: "act today",
        example: "an outage, or a security advisory in something the user depends on",
        you: { example: "an outage, or a security advisory in something you depend on" },
      },
      {
        level: 4,
        meaning: "act this week",
        example: "a serious bug, or a breaking change about to reach the user",
        you: { example: "a serious bug, or a breaking change about to reach you" },
      },
      { level: 3, meaning: "plan for it this month", example: "a bug with a workaround, or a deprecation with a date" },
      { level: 2, meaning: "minor, with no deadline", example: "a cosmetic bug or a small complaint" },
      {
        level: 1,
        meaning: "nothing urgent or harmful",
        example: "a feature request, a competitor's launch, or routine news",
      },
    ],
  },
  importance: {
    name: "Importance",
    about: "how much the Item matters to the user",
    you: { about: "how much the Item matters to you" },
    levels: [
      {
        level: 5,
        meaning: "directly about the user's product, or a key competitor or customer",
        you: { meaning: "directly about your product, or a key competitor or customer" },
      },
      {
        level: 4,
        meaning: "about something else the Profile names",
        example: "another competitor, a dependency or a tracked market",
      },
      {
        level: 3,
        meaning: "about the user's field in general, and useful to know",
        example: "a trend or a product in an adjacent space",
        you: { meaning: "about your field in general, and useful to know" },
      },
      {
        level: 2,
        meaning: "only loosely related",
        example: "general news that touches one of the user's interests",
        you: { example: "general news that touches one of your interests" },
      },
      { level: 1, meaning: "unrelated to anything in the Profile", example: "off-topic posts or spam" },
    ],
  },
};

/** The line `reader` gets: the Agent's own, unless the scale writes a different one for the reader. */
const asReadBy = (reader: RatingReader, agent: string, you: string | undefined) =>
  reader === "agent" || you === undefined ? agent : you;

/** What an axis is about, which the guide says beside its name. */
export const ratingAbout = ({ about, you }: RatingAxisScale, reader: RatingReader) =>
  asReadBy(reader, about, you?.about);

/** What a level means. The database and the output schema both keep a level on the scale. */
export function ratingMeaning(axis: RatingAxis, level: number, reader: RatingReader) {
  const found = ratingScale[axis].levels.find((entry) => entry.level === level);
  if (found === undefined) throw new RangeError(`${axis} has no level ${String(level)}`);
  return asReadBy(reader, found.meaning, found.you?.meaning);
}

/** A level's meaning and example together, as `reader` reads them. */
export const ratingAnchor = (
  { meaning, example, you }: { meaning: string; example?: string | undefined; you?: Addressed },
  reader: RatingReader,
) => {
  const says = asReadBy(reader, meaning, you?.meaning);
  // An example only says something else to the reader where the Agent's names the user.
  if (example === undefined) return says;
  return `${says}, e.g. ${asReadBy(reader, example, you?.example)}`;
};

const anchors = ratingAxes
  .map((axis) => {
    const { name, about, levels } = ratingScale[axis];
    const lines = levels.map((entry) => `${String(entry.level)}: ${ratingAnchor(entry, "agent")}.`);
    return `${name}, ${about}:\n${lines.join("\n")}`;
  })
  .join("\n\n");

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
