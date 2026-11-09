// The canonical rule model (docs: Rule model; ADR 0007). The form and YAML are views of these shapes,
// so the schemas are strict: a key they don't know would otherwise vanish on the way through.
import { z } from "zod";
import { cssError } from "./css.ts";
import { jsonPathError } from "./jsonpath.ts";
import { scheduleError } from "../schedule.ts";
import { captureRegexError, regexError } from "./regex.ts";

const sourceAndContent = ["source", "source.type", "title", "body", "author", "url", "language"];
const sourceContentAndCategories = [...sourceAndContent, "category"];
/** The Rating's fields. An unrated Item has neither (docs: Processing pipeline, "The Act stage"). */
export const ratingFields = ["severity", "importance"];
const namedFields = [...sourceContentAndCategories, ...ratingFields];

// Extracted field names become object keys, in stored fields and the Agent's flat output schema
// (ADR 0016), and assigning to `__proto__` wouldn't create a key.
const fieldName = /^(?!__proto__$)[\w-]{1,64}$/;
export const extracted = "fields.";

// Each predicate and field can run a regex at the instruction cap, so one rule's size bounds what
// it can cost per Item (ADR 0026). 50 is far beyond a rule a person writes.
const maxConditionNodes = 50;
const maxFields = 50;

function isConditionField(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return value.startsWith(extracted)
    ? fieldName.test(value.slice(extracted.length))
    : namedFields.includes(value);
}

const conditionField = z.custom<string>(isConditionField, {
  error: ({ input }) =>
    typeof input === "string"
      ? `"${input}" isn't a field a rule can test.`
      : "A predicate needs a field to test.",
});

/** A branch of `byShape` for a value that fits no other: it fails with this message. */
const refused = (error: string) => z.custom<never>(() => false, { error });

const notStringOrNumber = "The value is a string or a number.";

/** A string that `findError` has nothing to say about. */
function refusedBy(findError: (value: string) => string | undefined) {
  return z.string().superRefine((value, ctx) => {
    const message = findError(value);
    if (message !== undefined) ctx.addIssue({ code: "custom", message });
  });
}

const predicateSchema = z.discriminatedUnion(
  "op",
  [
    z.strictObject({
      field: conditionField,
      op: z.literal("is"),
      value: z.union([z.string(), z.number()], { error: notStringOrNumber }),
    }),
    z.strictObject({
      field: conditionField,
      op: z.literal("in"),
      value: z.array(z.union([z.string(), z.number()], { error: notStringOrNumber })).min(1),
    }),
    z.strictObject({ field: conditionField, op: z.literal("contains"), value: z.string().min(1) }),
    z.strictObject({ field: conditionField, op: z.literal("matches"), value: refusedBy(regexError) }),
    z.strictObject({ field: conditionField, op: z.literal("gte"), value: z.number() }),
    z.strictObject({ field: conditionField, op: z.literal("lte"), value: z.number() }),
    z.strictObject({ field: conditionField, op: z.literal("exists") }),
  ],
  { error: "A predicate's operator is one of is, in, contains, matches, gte, lte or exists." },
);

export type Predicate = z.infer<typeof predicateSchema>;
export type Condition = { all: Condition[] } | { any: Condition[] } | { not: Condition } | Predicate;

function has(value: unknown, key: string) {
  return typeof value === "object" && value !== null && key in value;
}

/**
 * A union that picks its branch from the value's shape. `z.union` reports only "Invalid input" when
 * every branch fails, and the Rules screen shows each message beside its field.
 */
function byShape<T>(pick: (value: unknown) => z.ZodType<T>) {
  return z.unknown().transform((value, ctx): T => {
    const result = pick(value).safeParse(value);
    if (result.success) return result.data;
    for (const issue of result.error.issues) ctx.addIssue({ ...issue });
    return z.NEVER;
  });
}

const allSchema = z.strictObject({ all: z.array(z.lazy(() => nodeSchema)).min(1) });
const anySchema = z.strictObject({ any: z.array(z.lazy(() => nodeSchema)).min(1) });
const notSchema = z.strictObject({ not: z.lazy(() => nodeSchema) });
const notACondition = refused("A Condition is all, any, not or a predicate.");

const nodeSchema: z.ZodType<Condition> = byShape<Condition>((value) => {
  if (typeof value !== "object" || value === null) return notACondition;
  if (has(value, "all")) return allSchema;
  if (has(value, "any")) return anySchema;
  if (has(value, "not")) return notSchema;
  return predicateSchema;
});

/**
 * Counted before the tree is validated and without recursion, because it may yet be deep enough to
 * overflow the stack, or contain itself through a YAML alias.
 */
function hasTooManyNodes(condition: unknown) {
  const pending = [condition];
  let nodes = 0;
  while (pending.length > 0) {
    const node = pending.pop();
    if (typeof node !== "object" || node === null) continue;
    if (++nodes > maxConditionNodes) return true;
    for (const [key, value] of Object.entries(node)) {
      if (key === "all" || key === "any" || key === "not") {
        for (const child of [value].flat()) pending.push(child);
      }
    }
  }
  return false;
}

/** A boolean tree of predicates on any field: the shape of M3's Action Conditions. */
export const conditionSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    if (hasTooManyNodes(value)) {
      ctx.addIssue({
        code: "custom",
        message: `A Condition can have at most ${String(maxConditionNodes)} parts, counting each predicate, all, any and not.`,
      });
    }
  })
  .pipe(nodeSchema);

/** Every predicate in a Condition's tree, with its path for an issue. */
export function* predicates(
  condition: Condition,
  path: PropertyKey[] = [],
): Generator<{ field: string; predicate: Predicate; path: PropertyKey[] }> {
  if ("all" in condition) {
    for (const [i, child] of condition.all.entries()) yield* predicates(child, [...path, "all", i]);
  } else if ("any" in condition) {
    for (const [i, child] of condition.any.entries()) yield* predicates(child, [...path, "any", i]);
  } else if ("not" in condition) {
    yield* predicates(condition.not, [...path, "not"]);
  } else {
    yield { field: condition.field, predicate: condition, path: [...path, "field"] };
  }
}

/** A Condition limited to what exists when its rule runs (docs: Rule model, "What each rule can test"). */
function conditionAtStage(allowed: string[], refusal: (field: string) => string) {
  return conditionSchema.superRefine((condition, ctx) => {
    for (const { field, path } of predicates(condition)) {
      if (!allowed.includes(field)) {
        ctx.addIssue({ code: "custom", path, message: refusal(field) });
      }
    }
  });
}

const classifierWhen = conditionAtStage(
  sourceAndContent,
  (field) =>
    `A deterministic Classifier's "when" can't test "${field}": it can test only Source and content.`,
);
const extractorRuleWhen = conditionAtStage(
  sourceContentAndCategories,
  (field) =>
    `An Extractor Rule's Condition can't test "${field}": it can test only Categories, Source and content.`,
);

const label = z.string().trim().min(1);
const name = z.string().regex(fieldName, "A field name is letters, digits, _ and -, at most 64.");
// Kept as written, so a prompt's own line breaks survive the YAML view.
const prompt = z.string().refine((text) => text.trim() !== "", "A prompt can't be blank.");

/** Fields with their names unique, since an Item stores one value per field name. */
function fieldList<T extends { name: string }>(fieldSchema: z.ZodType<T>) {
  return z
    .array(fieldSchema)
    .min(1)
    .max(maxFields)
    .superRefine((fields, ctx) => {
      for (const [i, field] of fields.entries()) {
        if (fields.findIndex((other) => other.name === field.name) < i) {
          ctx.addIssue({
            code: "custom",
            path: [i, "name"],
            message: `A rule can't declare the field "${field.name}" twice.`,
          });
        }
      }
    });
}

const singleType = z.enum(["string", "integer"]);
const anyType = z.enum(["string", "integer", "string-array", "integer-array"]);

// One capture group gives one value, so only JSONPath and CSS can fill an array.
const regexFieldSchema = z.strictObject({
  name,
  type: singleType,
  from: z.enum(["title", "body"]),
  regex: refusedBy(captureRegexError),
});
const jsonPathFieldSchema = z.strictObject({
  name,
  type: anyType,
  jsonpath: refusedBy(jsonPathError),
});

const cssFieldSchema = z.strictObject({
  name,
  type: anyType,
  css: refusedBy(cssError),
  attr: z
    .string()
    .regex(/^[^\s"'>/=]+$/, "An attribute name is one word, without quotes, >, / or =.")
    .optional(),
});

type DeterministicField =
  | z.infer<typeof regexFieldSchema>
  | z.infer<typeof jsonPathFieldSchema>
  | z.infer<typeof cssFieldSchema>;

const readings = { regex: regexFieldSchema, jsonpath: jsonPathFieldSchema, css: cssFieldSchema };
const notOneReading = refused("A field reads from exactly one of regex, jsonpath or css.");

const deterministicFieldSchema = byShape<DeterministicField>((value) => {
  const [reading, ...others] = Object.entries(readings).filter(([key]) => has(value, key));
  return reading === undefined || others.length > 0 ? notOneReading : reading[1];
});

export const deterministicClassifierSchema = z.strictObject({
  classifier: label,
  when: classifierWhen,
  assign: z.array(label).min(1),
});

export const agentClassifierSchema = z.strictObject({
  classifier: label,
  prompt,
  /** The Categories the Agent may assign. */
  categories: z.array(label).min(1),
});

export const deterministicExtractorRuleSchema = z.strictObject({
  extractor: label,
  when: extractorRuleWhen,
  fields: fieldList(deterministicFieldSchema),
});

export const agentExtractorRuleSchema = z.strictObject({
  extractor: label,
  when: extractorRuleWhen,
  prompt,
  fields: fieldList(z.strictObject({ name, type: anyType })),
});

export type DeterministicClassifier = z.infer<typeof deterministicClassifierSchema>;
export type AgentClassifier = z.infer<typeof agentClassifierSchema>;
export type DeterministicExtractorRule = z.infer<typeof deterministicExtractorRuleSchema>;
export type AgentExtractorRule = z.infer<typeof agentExtractorRuleSchema>;

// By name in the YAML and by id once stored, so only a save can tell whether they exist or fit the
// kind, which it does with the Workspace's Destinations in hand.
const destinations = z
  .array(label)
  .min(1)
  .superRefine((names, ctx) => {
    for (const [i, listed] of names.entries()) {
      if (names.indexOf(listed) < i) {
        ctx.addIssue({
          code: "custom",
          path: [i],
          message: `An Action can't list the Destination "${listed}" twice.`,
        });
      }
    }
  });

// This schema has no mode, so it asks only for a cron expression. A save applies the mode's minimum.
const digestSchedule = z.string().trim().min(1).pipe(refusedBy(scheduleError));

// A Rating is a whole number, so `is 2.5` could never hold.
const isOnRatingScale = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5;

/** A Rating test that no Item could meet saves as if it worked and never fires, or under `not`, always. */
const actionWhen = conditionSchema.superRefine((condition, ctx) => {
  for (const { field, predicate, path } of predicates(condition)) {
    if (!ratingFields.includes(field) || predicate.op === "exists") continue;
    if (![predicate.value].flat().every(isOnRatingScale)) {
      ctx.addIssue({
        code: "custom",
        path: [...path.slice(0, -1), "value"],
        message: `"${field}" is rated 1 to 5, so a test on it takes those whole numbers.`,
      });
    }
  }
});

// An Action runs after every other stage, so its Condition can test any field (docs: Rule model,
// "What each rule can test"). The keys are in the order the Rule model page writes them.
export const actionSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({
      action: label,
      when: actionWhen,
      kind: z.enum(["alert", "webhook"]),
      destinations,
    }),
    z.strictObject({
      action: label,
      when: actionWhen,
      kind: z.literal("digest"),
      schedule: digestSchedule,
      destinations,
    }),
  ],
  { error: "An Action's kind is alert, webhook or digest." },
);

export type Action = z.infer<typeof actionSchema>;

export type Classifier = DeterministicClassifier | AgentClassifier;
export type ExtractorRule = DeterministicExtractorRule | AgentExtractorRule;
export type Rule = Classifier | ExtractorRule | Action;

export const classifierSchema = byShape<Classifier>((value) =>
  has(value, "prompt") ? agentClassifierSchema : deterministicClassifierSchema,
);

export const extractorRuleSchema = byShape<ExtractorRule>((value) =>
  has(value, "prompt") ? agentExtractorRuleSchema : deterministicExtractorRuleSchema,
);

const notARule = refused('A rule starts with "classifier:", "extractor:" or "action:" and its name.');

export const ruleSchema = byShape<Rule>((value) => {
  if (has(value, "classifier")) return classifierSchema;
  if (has(value, "extractor")) return extractorRuleSchema;
  return has(value, "action") ? actionSchema : notARule;
});
