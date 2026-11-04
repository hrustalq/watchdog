// The draft behind the Rules screen's Form and YAML views: a plain object that may not be a valid
// rule yet. The form edits it in place and shows what it can, so whatever it can't show stays in the
// draft for the YAML view. Runs in the browser, so it can't import @watchdog/core's main entry.
import { draftFromYaml, draftToYaml } from "@watchdog/core/rules/draft";

export type RuleType = "classifier" | "extractor";
export type RuleKind = "deterministic" | "agent";
export type Draft = Record<string, unknown>;
export type Path = readonly (string | number)[];

/** Why a rule wasn't saved. `path` is the dotted way to the value, and "" is the rule as a whole. */
export interface RuleProblem {
  path: string;
  message: string;
}

export const pathKey = (path: Path) => path.join(".");

export const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isScalar = (value: unknown): value is string | number =>
  typeof value === "string" || typeof value === "number";
const isScalarOrAbsent = (value: unknown) => value === undefined || isScalar(value);
export const isScalarList = (value: unknown): value is (string | number)[] =>
  Array.isArray(value) && value.every(isScalar);
const onlyHas = (map: Record<string, unknown>, keys: string[]) =>
  Object.keys(map).every((key) => keys.includes(key));

export const blankTest = { field: "title", op: "contains", value: "" };

/** A new rule with the shape the form shows, ready to be filled in. */
export function blankRule(type: RuleType, kind: RuleKind): Draft {
  if (type === "classifier") {
    return kind === "agent"
      ? { classifier: "", prompt: "", categories: [] }
      : { classifier: "", when: blankTest, assign: [] };
  }
  return kind === "agent"
    ? { extractor: "", when: blankTest, prompt: "", fields: [blankField(kind)] }
    : { extractor: "", when: blankTest, fields: [blankField(kind)] };
}

export const blankField = (kind: RuleKind) =>
  kind === "agent"
    ? { name: "", type: "string" }
    : { name: "", type: "string", from: "title", regex: "" };

/** Which rule a draft is, read the way `ruleSchema` picks its branch. */
export const ruleTypeOf = (draft: Draft): RuleType => ("classifier" in draft ? "classifier" : "extractor");
export const kindOf = (draft: Draft): RuleKind => ("prompt" in draft ? "agent" : "deterministic");

const removed = Symbol("removed");

function updated(value: unknown, [key, ...rest]: Path, next: unknown): unknown {
  if (key === undefined) return next;
  if (Array.isArray(value)) {
    const copy: unknown[] = [...value];
    const child = updated(copy[Number(key)], rest, next);
    if (child === removed) copy.splice(Number(key), 1);
    else copy[Number(key)] = child;
    return copy;
  }
  const copy = isMap(value) ? { ...value } : {};
  const child = updated(copy[key], rest, next);
  if (child === removed) delete copy[key];
  else copy[key] = child;
  return copy;
}

/** The draft with the value at `path` replaced, leaving the draft it was given alone. */
export function setAt(draft: Draft, path: Path, value: unknown): Draft {
  const next = updated(draft, path, value);
  return isMap(next) ? next : draft;
}

/** The draft with the key or list entry at `path` gone. */
export const removeAt = (draft: Draft, path: Path) => setAt(draft, path, removed);

export function valueAt(draft: Draft, path: Path) {
  let value: unknown = draft;
  for (const key of path) {
    if (Array.isArray(value)) value = value[Number(key)];
    else value = isMap(value) ? value[key] : undefined;
  }
  return value;
}

/** Why the YAML parser refused some text. */
export function unreadable(error: unknown) {
  if (error instanceof RangeError) return "This YAML nests too deeply to read.";
  return error instanceof Error ? error.message : "This YAML can't be read.";
}

/**
 * The draft in this YAML, or why the form can't take it. The form needs a mapping that names its
 * rule to know which fields to show. Everything else it can keep, however wrong.
 */
export function readDraft(text: string): { draft: Draft } | { error: string } {
  let value: unknown;
  try {
    value = draftFromYaml(text);
  } catch (error) {
    return { error: unreadable(error) };
  }
  if (!isMap(value) || !("classifier" in value || "extractor" in value)) {
    return { error: 'A rule starts with "classifier:" or "extractor:" and its name.' };
  }
  try {
    // An alias can make the value contain itself, and the form's walk would never end.
    draftToYaml(value);
  } catch {
    return { error: "This YAML has an alias that contains itself, so only the YAML view can hold it." };
  }
  return { draft: value };
}

export type ConditionPart = "all" | "any" | "not" | "predicate" | "yaml-only";

// Far more than the 50 parts a rule may have, and enough to keep rendering cheap.
const maxRenderedParts = 200;

function tooBigToRender(condition: unknown) {
  const pending = [condition];
  let parts = 0;
  while (pending.length > 0) {
    const node = pending.pop();
    if (!isMap(node)) continue;
    if (++parts > maxRenderedParts) return true;
    for (const key of ["all", "any", "not"]) pending.push(...[node[key]].flat());
  }
  return false;
}

/** How the form shows one node of a Condition. */
export function conditionPart(node: unknown): ConditionPart {
  if (!isMap(node) || tooBigToRender(node)) return "yaml-only";
  const keys = Object.keys(node);
  if (keys.length === 1) {
    if (Array.isArray(node.all)) return "all";
    if (Array.isArray(node.any)) return "any";
    if ("not" in node) return "not";
  }
  const showable =
    onlyHas(node, ["field", "op", "value"]) &&
    typeof node.field === "string" &&
    typeof node.op === "string" &&
    (isScalarOrAbsent(node.value) || isScalarList(node.value));
  return showable ? "predicate" : "yaml-only";
}

export type FieldPart = "regex" | "jsonpath" | "agent" | "yaml-only";

/** How the form shows one field of an Extractor Rule. */
export function fieldPart(field: unknown, kind: RuleKind): FieldPart {
  if (!isMap(field) || !Object.values(field).every(isScalar)) return "yaml-only";
  if (kind === "agent") return onlyHas(field, ["name", "type"]) ? "agent" : "yaml-only";
  if ("jsonpath" in field) return onlyHas(field, ["name", "type", "jsonpath"]) ? "jsonpath" : "yaml-only";
  return onlyHas(field, ["name", "type", "from", "regex"]) ? "regex" : "yaml-only";
}

/** The field reading from a regex or a JSONPath. One capture group gives one value, so a regex can't fill an array. */
export function fieldReading(field: Record<string, unknown>, part: "regex" | "jsonpath") {
  const { name, type } = field;
  if (part === "jsonpath") return { name, type, jsonpath: "" };
  return { name, type: type === "integer" ? type : "string", from: "title", regex: "" };
}

/** The Condition with one more test: added to a group, or grouped with a lone part. */
export function addTest(node: unknown) {
  return addPart(node, blankTest);
}

export function addPart(node: unknown, part: unknown) {
  if (isMap(node)) {
    if (Array.isArray(node.all)) return { all: [...node.all, part] };
    if (Array.isArray(node.any)) return { any: [...node.any, part] };
  }
  return { all: [node, part] };
}

/** The part with `not` around it, or without the one it has. */
export function negate(node: unknown) {
  return isMap(node) && conditionPart(node) === "not" ? node.not : { not: node };
}

/** The predicate under another operator, keeping its value where that operator can hold it. */
export function changeOp(predicate: Record<string, unknown>, op: string) {
  const { field, value } = predicate;
  if (op === "exists") return { field, op };
  if (op === "in") {
    if (Array.isArray(value)) return { field, op, value };
    return { field, op, value: value === undefined ? [] : [value] };
  }
  if (Array.isArray(value)) return { field, op, value: value[0] ?? "" };
  return { field, op, value: value ?? "" };
}

/**
 * What a predicate's text box holds as a value. `gte` and `lte` take numbers, and text the form
 * can't make one of stays as typed, for the server to refuse. The other operators take text, but a
 * number from the YAML view stays a number. Only text that round-trips counts, so typing "4.05"
 * survives passing through "4.0".
 */
export function typedValue(op: string, previous: unknown, text: string): string | number {
  const wantsNumber = op === "gte" || op === "lte" || typeof previous === "number";
  return wantsNumber && /^-?\d/.test(text) && String(Number(text)) === text ? Number(text) : text;
}

/**
 * A one-per-line text box as a list. While typing, every line stays, or a new line couldn't be
 * started. `tidy` is for when the user has left the box.
 */
export function fromLines(text: string, { tidy = false } = {}) {
  if (text === "") return [];
  const lines = text.split("\n");
  return tidy ? lines.map((line) => line.trim()).filter((line) => line !== "") : lines;
}

/** The rule's top-level keys the form has no control for. They stay in the draft. */
export function formHides(draft: Draft) {
  const type = ruleTypeOf(draft);
  const agent = kindOf(draft) === "agent";
  const shown =
    type === "classifier"
      ? agent
        ? ["classifier", "prompt", "categories"]
        : ["classifier", "when", "assign"]
      : agent
        ? ["extractor", "when", "prompt", "fields"]
        : ["extractor", "when", "fields"];
  return Object.entries(draft)
    .filter(([key, value]) => {
      if (!shown.includes(key)) return true;
      if (key === "when") return false;
      if (key === "assign" || key === "categories") return !isScalarList(value);
      if (key === "fields") return !Array.isArray(value);
      return !isScalar(value);
    })
    .map(([key]) => key);
}

const placedInForm = [
  /^(?:classifier|extractor|prompt|(?:assign|categories)(?:\.\d+)?|fields(?:\.\d+(?:\.(?:name|type|from|regex|jsonpath))?)?)$/,
  /^when(?:\.(?:all|any)\.\d+|\.not)*(?:\.(?:all|any|field|op|value(?:\.\d+)?))?$/,
];

/** Whether the form has a place beside a field for a problem at this path. The rest go in a summary. */
export const formShows = (path: string) => placedInForm.some((place) => place.test(path));
