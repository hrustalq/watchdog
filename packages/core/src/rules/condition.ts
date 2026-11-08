// Evaluating a Condition against an Item (docs: Rule model, "Condition grammar").
import { regexMatches } from "./regex.ts";
import { type Condition, extracted, type Predicate, ratingFields } from "./schema.ts";

/**
 * What a Condition can read from an Item: its `item` row plus its Source's type. Forgetting one of
 * these would look like a missing field, and `not` would then hold on every Item, so they're
 * required. What later stages add is optional, because a stage passes what exists by then.
 */
export interface ConditionItem {
  sourceId: string | null;
  sourceType: string | null;
  title: string | null;
  body: string | null;
  author: string | null;
  url: string | null;
  language: string | null;
  categories?: readonly string[] | null;
  severity?: number | null;
  importance?: number | null;
  /** Extracted fields by name. */
  fields?: Readonly<Record<string, unknown>> | null;
}

function read(field: string, item: ConditionItem): unknown {
  if (field.startsWith(extracted)) {
    const name = field.slice(extracted.length);
    // A field can be named "constructor".
    return item.fields && Object.hasOwn(item.fields, name) ? item.fields[name] : undefined;
  }
  switch (field) {
    case "source":
      return item.sourceId;
    case "source.type":
      return item.sourceType;
    case "category":
      return item.categories;
    case "title":
    case "body":
    case "author":
    case "url":
    case "language":
    case "severity":
    case "importance":
      return item[field];
    default:
      return undefined;
  }
}

function test(predicate: Predicate, value: unknown) {
  switch (predicate.op) {
    case "is":
      return value === predicate.value;
    case "in":
      return predicate.value.some((option) => option === value);
    case "contains":
      return (
        typeof value === "string" && value.toLowerCase().includes(predicate.value.toLowerCase())
      );
    case "matches":
      return typeof value === "string" && regexMatches(predicate.value, value);
    case "gte":
      return typeof value === "number" && value >= predicate.value;
    case "lte":
      return typeof value === "number" && value <= predicate.value;
    case "exists":
      return true;
  }
}

/**
 * Whether an Item meets a Condition that passed `conditionSchema`. A field holding an array, such
 * as `category`, passes when any of its values does, and a missing field has no values, so it
 * fails every operator.
 */
export function evaluateCondition(condition: Condition, item: ConditionItem): boolean {
  if ("all" in condition) return condition.all.every((child) => evaluateCondition(child, item));
  if ("any" in condition) return condition.any.some((child) => evaluateCondition(child, item));
  if ("not" in condition) return !evaluateCondition(condition.not, item);
  return [read(condition.field, item)]
    .flat()
    .some((value) => value !== undefined && value !== null && test(condition, value));
}

/** `undefined` is unknown: a Rating test on an unrated Item. */
function evaluateWithUnknown(
  condition: Condition,
  item: ConditionItem & { severity: number | null },
): boolean | undefined {
  if ("all" in condition) {
    const values = condition.all.map((child) => evaluateWithUnknown(child, item));
    return values.includes(false) ? false : values.includes(undefined) ? undefined : true;
  }
  if ("any" in condition) {
    const values = condition.any.map((child) => evaluateWithUnknown(child, item));
    return values.includes(true) ? true : values.includes(undefined) ? undefined : false;
  }
  if ("not" in condition) {
    const value = evaluateWithUnknown(condition.not, item);
    return value === undefined ? undefined : !value;
  }
  if (item.severity === null && ratingFields.includes(condition.field)) return undefined;
  return evaluateCondition(condition, item);
}

/**
 * Whether an Item that finished the pipeline meets an Action's Condition (docs: Processing
 * pipeline, "The Act stage"). On an unrated Item a test of `severity` or `importance` is unknown,
 * `exists` included: `not` keeps it unknown, `all` is false if a child is false and `any` true if a
 * child is true, and unknown at the root doesn't hold. So an unrated Item meets neither "Severity ≥
 * 4" nor "not Severity ≥ 4", while `any: [Category is security-advisory, Severity ≥ 4]` fires on an
 * advisory. Unrated means `severity` is null, so a corrected Rating counts as rated. The Rating is
 * required here, because a stage that forgot it would look unrated on every Item.
 */
export function evaluateActionCondition(
  condition: Condition,
  item: ConditionItem & { severity: number | null },
): boolean {
  return evaluateWithUnknown(condition, item) === true;
}
