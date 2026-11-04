// The deterministic Extractor Rule stage (docs: Processing pipeline, "Stages"; Rule model).
import { eq, extractorRule, itemCategory, itemField, itemLog, type Tx } from "@watchdog/db";
import { type ConditionItem, evaluateCondition } from "../rules/condition.ts";
import { jsonPathValues } from "../rules/jsonpath.ts";
import { firstCapture } from "../rules/regex.ts";
import { type DeterministicExtractorRule, deterministicExtractorRuleSchema } from "../rules/schema.ts";
import { deterministicRulesFor } from "./deterministic-rules.ts";

type Field = DeterministicExtractorRule["fields"][number];
type Value = string | number;

/** What a field can read from an Item. */
export interface ExtractionSource {
  title: string | null;
  body: string | null;
  raw: unknown;
}

export interface Extraction {
  values: { name: string; value: Value | Value[] }[];
  /** Fields with nothing to read, which isn't an error. */
  empty: string[];
  /** Fields whose values couldn't be stored. A reason never repeats a value, which is Source text. */
  problems: { name: string; reason: string }[];
}

/** What the field finds, or undefined when `raw` nests too deeply to read. */
function read(field: Field, source: ExtractionSource): unknown[] | undefined {
  if ("jsonpath" in field) return jsonPathValues(field.jsonpath, source.raw);
  const text = source[field.from];
  const captured = text === null ? undefined : firstCapture(field.regex, text);
  return captured === undefined ? [] : [captured];
}

function asString(value: unknown) {
  if (typeof value === "string") return value;
  return typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
}

function asInteger(value: unknown) {
  const number = typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) ? number : undefined;
}

function kindOf(value: unknown) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/** Reads each field of a rule, converting its values to the type the rule declares. */
export function extractFields(fields: readonly Field[], source: ExtractionSource): Extraction {
  const extraction: Extraction = { values: [], empty: [], problems: [] };
  for (const field of fields) {
    const { name } = field;
    const found = read(field, source);
    if (found === undefined) {
      extraction.problems.push({ name, reason: "the Item's raw payload nests too deeply to read" });
      continue;
    }
    // A single type takes the first value, as a regex takes its first match. A path that lands on
    // an array means its values, so `$.tags` and `$.tags[*]` fill an array alike.
    const isArray = field.type.endsWith("-array");
    const wanted = isArray ? found.flat() : found.slice(0, 1);
    if (wanted.length === 0) {
      extraction.empty.push(name);
      continue;
    }
    const target = field.type.startsWith("string") ? "string" : "integer";
    const convert: (value: unknown) => Value | undefined = target === "string" ? asString : asInteger;
    const converted = wanted.map(convert).filter((value) => value !== undefined);
    // All of an array or none of it: a shorter list would look like a true one.
    if (converted.length < wanted.length) {
      const refused = wanted.find((value) => convert(value) === undefined);
      const reason = `it holds ${kindOf(refused)}, which can't convert to ${target}`;
      extraction.problems.push({ name, reason });
      continue;
    }
    extraction.values.push({ name, value: isArray ? converted : (converted[0] as Value) });
  }
  return extraction;
}

/**
 * Runs the Workspace's enabled deterministic Extractor Rules on an Item, oldest first, so the first
 * rule to fill a field is the one its row names. A Condition reads the Categories from the table, so
 * it sees every Classifier that ran before this stage, deterministic or Agent-backed (GitHub issue
 * #79).
 */
export async function runDeterministicExtractorRules(
  tx: Tx,
  itemId: string,
  target: ConditionItem & ExtractionSource,
) {
  const rules = await deterministicRulesFor(tx, extractorRule, itemId);
  const assigned = await tx
    .select({ category: itemCategory.category })
    .from(itemCategory)
    .where(eq(itemCategory.itemId, itemId));
  const categories = assigned.map((row) => row.category);

  const log = (message: string, data: Record<string, unknown>) =>
    tx.insert(itemLog).values({ itemId, stage: "extract", message, data });

  for (const rule of rules) {
    const parsed = deterministicExtractorRuleSchema.safeParse(rule.definition);
    if (!parsed.success) {
      await log(`Skipped Extractor Rule ${rule.name}: its definition no longer parses`, {
        extractorRuleId: rule.id,
        extractor: rule.name,
        issues: parsed.error.issues.map((issue) => issue.message),
      });
      continue;
    }
    if (!evaluateCondition(parsed.data.when, { ...target, categories })) continue;

    const { values, empty, problems } = extractFields(parsed.data.fields, target);
    const stored =
      values.length === 0
        ? []
        : await tx
            .insert(itemField)
            .values(values.map((field) => ({ itemId, ...field, extractorRuleId: rule.id })))
            .onConflictDoNothing()
            .returning({ name: itemField.name });
    const fields = stored.map((row) => row.name);
    for (const { name } of values) {
      if (!fields.includes(name)) problems.push({ name, reason: "an earlier rule already filled it" });
    }

    const outcomes = [
      ...(fields.length > 0 ? [`extracted ${fields.join(", ")}`] : []),
      ...(empty.length > 0 ? [`found no value for ${empty.join(", ")}`] : []),
      ...problems.map(({ name, reason }) => `stored nothing for ${name}: ${reason}`),
    ];
    await log(`Extractor Rule ${rule.name} ${outcomes.join("; ")}`, {
      extractorRuleId: rule.id,
      extractor: rule.name,
      fields,
      empty,
      problems,
    });
  }
}
