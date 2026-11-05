// The deterministic Extractor Rule stage (docs: Processing pipeline, "Stages"; Rule model).
import { and, type Db, eq, extractorRule, inArray, itemCategory, itemField, type Tx } from "@watchdog/db";
import type { z } from "zod";
import { type ConditionItem, evaluateCondition } from "../rules/condition.ts";
import { jsonPathValues, maxFieldValues } from "../rules/jsonpath.ts";
import { firstCapture } from "../rules/regex.ts";
import { type DeterministicExtractorRule, deterministicExtractorRuleSchema } from "../rules/schema.ts";
import { logOnce, rulesFor } from "./rules-for-item.ts";

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

/**
 * Converts what each field of a rule found to the type the rule declares. `find` gives the field's
 * values, or undefined when they can't be read.
 */
export function toExtraction<Declared extends { name: string; type: Field["type"] }>(
  fields: readonly Declared[],
  find: (field: Declared) => unknown[] | undefined,
): Extraction {
  const extraction: Extraction = { values: [], empty: [], problems: [] };
  for (const field of fields) {
    const { name } = field;
    const found = find(field);
    if (found === undefined) {
      extraction.problems.push({ name, reason: "the Item's raw payload nests too deeply to read" });
      continue;
    }
    // A path that lands on one array means its values, so `$.tags` and `$.tags[*]` read alike. A
    // single type takes the first value, as a regex takes its first match.
    const [only] = found;
    const all: unknown[] = found.length === 1 && Array.isArray(only) ? only : found;
    const isArray = field.type.endsWith("-array");
    const wanted = isArray ? all : all.slice(0, 1);
    if (wanted.length === 0) {
      extraction.empty.push(name);
      continue;
    }
    if (wanted.length > maxFieldValues) {
      extraction.problems.push({ name, reason: `it found more than ${String(maxFieldValues)} values` });
      continue;
    }
    const target = field.type.startsWith("string") ? "string" : "integer";
    const convert: (value: unknown) => Value | undefined = target === "string" ? asString : asInteger;
    const converted = wanted.map(convert).filter((value) => value !== undefined);
    const [first] = converted;
    // All of an array or none of it: a shorter list would look like a true one.
    if (first === undefined || converted.length < wanted.length) {
      const refused = wanted.find((value) => convert(value) === undefined);
      const reason = `it holds ${kindOf(refused)}, which can't convert to ${target}`;
      extraction.problems.push({ name, reason });
      continue;
    }
    extraction.values.push({ name, value: isArray ? converted : first });
  }
  return extraction;
}

/** Reads each field of a deterministic rule from the Item. */
export function extractFields(fields: readonly Field[], source: ExtractionSource): Extraction {
  return toExtraction(fields, (field) => read(field, source));
}

export async function categoriesOf(db: Pick<Db | Tx, "select">, itemId: string) {
  const assigned = await db
    .select({ category: itemCategory.category })
    .from(itemCategory)
    .where(eq(itemCategory.itemId, itemId));
  return assigned.map((row) => row.category);
}

export const logSkippedRule = (
  log: Awaited<ReturnType<typeof logOnce>>,
  rule: { id: string; name: string },
  error: z.ZodError,
) =>
  log(`Skipped Extractor Rule ${rule.name}: its definition no longer parses`, {
    extractorRuleId: rule.id,
    extractor: rule.name,
    issues: error.issues.map((issue) => issue.message),
  });

/** Stores what a rule found and logs it. The first rule to fill a field keeps it. */
export async function storeExtraction(
  tx: Tx,
  log: Awaited<ReturnType<typeof logOnce>>,
  itemId: string,
  rule: { id: string; name: string },
  { values, empty, problems }: Extraction,
) {
  const stored =
    values.length === 0
      ? []
      : await tx
          .insert(itemField)
          .values(values.map((field) => ({ itemId, ...field, extractorRuleId: rule.id })))
          .onConflictDoNothing()
          .returning({ name: itemField.name });
  const fields = stored.map((row) => row.name);
  const refused = values
    .filter(({ name }) => !fields.includes(name))
    .map(({ name }) => ({ name, reason: "an earlier rule already filled it" }));
  const allProblems = [...problems, ...refused];

  const outcomes = [
    ...(fields.length > 0 ? [`extracted ${fields.join(", ")}`] : []),
    ...(empty.length > 0 ? [`found no value for ${empty.join(", ")}`] : []),
    ...allProblems.map(({ name, reason }) => `stored nothing for ${name}: ${reason}`),
  ];
  await log(`Extractor Rule ${rule.name} ${outcomes.join("; ")}`, {
    extractorRuleId: rule.id,
    extractor: rule.name,
    fields,
    empty,
    problems: allProblems,
  });
}

/**
 * Runs the Workspace's enabled deterministic Extractor Rules on an Item, oldest first, so the first
 * rule to fill a field is the one its row names. A Condition reads the Categories from the table, so
 * it sees every Classifier that ran before this stage, deterministic or Agent-backed (GitHub issue
 * #79). A retry runs them all again with the Categories it has now. It clears what they stored first,
 * so a field from an attempt whose classify call failed can't outlive a Condition that no longer holds
 * or beat an older rule that now fills it.
 */
export async function runDeterministicExtractorRules(
  tx: Tx,
  itemId: string,
  target: ConditionItem & ExtractionSource,
) {
  const rules = await rulesFor(tx, extractorRule, itemId, "deterministic");
  if (rules.length === 0) return;
  const log = await logOnce(tx, itemId, "extract");
  await tx.delete(itemField).where(
    and(
      eq(itemField.itemId, itemId),
      inArray(itemField.extractorRuleId, rules.map((rule) => rule.id)),
    ),
  );

  const categories = await categoriesOf(tx, itemId);

  for (const rule of rules) {
    const parsed = deterministicExtractorRuleSchema.safeParse(rule.definition);
    if (!parsed.success) {
      await logSkippedRule(log, rule, parsed.error);
      continue;
    }
    if (!evaluateCondition(parsed.data.when, { ...target, categories })) continue;
    await storeExtraction(tx, log, itemId, rule, extractFields(parsed.data.fields, target));
  }
}
