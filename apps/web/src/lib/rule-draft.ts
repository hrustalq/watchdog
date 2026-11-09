// The draft behind the Rules screen's Form and YAML views: a plain object that may not be a valid
// rule yet. The form edits it in place and shows what it can, so whatever it can't show stays in the
// draft for the YAML view. Runs in the browser, so it can't import @watchdog/core's main entry.
import { draftFromYaml, draftToYaml } from "@watchdog/core/rules/draft";

export type RuleType = "classifier" | "extractor" | "action";
export type RuleKind = "deterministic" | "agent";
export type ActionKind = "alert" | "webhook" | "digest";
export type Draft = Record<string, unknown>;
export type Path = readonly (string | number)[];

/** Why a rule wasn't saved. `path` is the dotted way to the value, and "" is the rule as a whole. */
export interface RuleProblem {
  path: string;
  message: string;
}

/**
 * The YAML field that only a browser without JavaScript posts, because it sits in a `<noscript>`.
 * Its presence is how the action knows that returning its problems would leave a blank page.
 */
export const yamlWithoutScript = "yamlWithoutScript";

export const pathKey = (path: Path) => path.join(".");

export const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isScalar = (value: unknown): value is string | number =>
  typeof value === "string" || typeof value === "number";
const isList = (value: unknown): value is unknown[] => Array.isArray(value);
export const isScalarList = (value: unknown): value is (string | number)[] =>
  isList(value) && value.every(isScalar);

/** A value as a list, or no entries when it isn't one. */
export const asList = (value: unknown) => (isList(value) ? value : []);
/** A value as the text a control shows, or nothing when it isn't one the control can show. */
export const textOf = (value: unknown) => (isScalar(value) ? String(value) : "");
const onlyHas = (map: Record<string, unknown>, keys: string[]) =>
  Object.keys(map).every((key) => keys.includes(key));

/** What the glossary calls each type of rule. */
export const ruleNoun: Record<RuleType, string> = { classifier: "Classifier", extractor: "Extractor Rule", action: "Action" };

/** The same, with its article. */
export const aRule = (type: RuleType) => `${type === "classifier" ? "a" : "an"} ${ruleNoun[type]}`;

/** A Destination as the Action editor offers it. Webhooks have no confirmation step, so they're always confirmed. */
export interface DestinationChoice {
  name: string;
  type: "telegram" | "email" | "webhook";
  confirmed: boolean;
}

/** A field an Extractor Rule declares, which an Action's Condition can test. */
export interface DeclaredField {
  name: string;
  type: string;
}

export const blankTest = { field: "title", op: "contains", value: "" };

/** A new rule with the shape the form shows, ready to be filled in. */
export function blankRule(type: RuleType, kind: RuleKind = "deterministic"): Draft {
  if (type === "action") return { action: "", when: blankTest, kind: "alert", destinations: [] };
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
export function ruleTypeOf(draft: Draft): RuleType {
  if ("classifier" in draft) return "classifier";
  return "extractor" in draft ? "extractor" : "action";
}
/** An Action has no such kind, and no model to wait for, whatever its draft holds. */
export const kindOf = (draft: Draft): RuleKind =>
  "prompt" in draft && ruleTypeOf(draft) !== "action" ? "agent" : "deterministic";

const actionKeys = ["action", "when", "kind", "schedule", "destinations"];

/** An Action's keys in the order the rule model writes them, then whatever else it holds. */
export function inActionOrder(draft: Draft): Draft {
  const entries = Object.entries(draft);
  const inOrder = actionKeys.flatMap((key) => entries.filter(([name]) => name === key));
  return Object.fromEntries([...inOrder, ...entries.filter(([name]) => !actionKeys.includes(name))]);
}

/** The Action under another kind. Only a Digest takes a schedule, and it starts blank for the user to fill in. */
export function changeKind({ schedule, ...draft }: Draft, kind: string): Draft {
  return inActionOrder(kind === "digest" ? { ...draft, kind, schedule: schedule ?? "" } : { ...draft, kind });
}

/** A webhook Action takes webhook Destinations only, and an alert or Digest takes the others. */
export const destinationFits = (kind: unknown, type: DestinationChoice["type"]) =>
  (type === "webhook") === (kind === "webhook");

const removed = Symbol("removed");

function updated(value: unknown, [key, ...rest]: Path, next: unknown): unknown {
  if (key === undefined) return next;
  if (isList(value)) {
    const copy = [...value];
    const child = updated(copy[Number(key)], rest, next);
    if (child === removed) copy.splice(Number(key), 1);
    else copy[Number(key)] = child;
    return copy;
  }
  const map = isMap(value) ? value : {};
  const child = updated(map[key], rest, next);
  if (child === removed) return Object.fromEntries(Object.entries(map).filter(([name]) => name !== key));
  return { ...map, [key]: child };
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
  if (!isMap(value) || !("classifier" in value || "extractor" in value || "action" in value)) {
    return { error: 'A rule starts with "classifier:", "extractor:" or "action:" and its name.' };
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
    // One at a time: a list pasted into the YAML can be longer than a call's arguments can be.
    for (const child of [node.all, node.any, node.not].flat()) pending.push(child);
  }
  return false;
}

/** How the form shows one node of a Condition. */
export function conditionPart(node: unknown): ConditionPart {
  if (!isMap(node) || tooBigToRender(node)) return "yaml-only";
  const keys = Object.keys(node);
  if (keys.length === 1) {
    if (isList(node.all)) return "all";
    if (isList(node.any)) return "any";
    if ("not" in node) return "not";
  }
  const showable =
    onlyHas(node, ["field", "op", "value"]) &&
    typeof node.field === "string" &&
    typeof node.op === "string" &&
    (node.value === undefined || isScalar(node.value) || isScalarList(node.value));
  return showable ? "predicate" : "yaml-only";
}

export type FieldPart = "regex" | "jsonpath" | "css" | "agent" | "yaml-only";

/** How the form shows one field of an Extractor Rule. */
export function fieldPart(field: unknown, kind: RuleKind): FieldPart {
  if (!isMap(field) || !Object.values(field).every(isScalar)) return "yaml-only";
  if (kind === "agent") return onlyHas(field, ["name", "type"]) ? "agent" : "yaml-only";
  if ("jsonpath" in field) return onlyHas(field, ["name", "type", "jsonpath"]) ? "jsonpath" : "yaml-only";
  if ("css" in field) return onlyHas(field, ["name", "type", "css", "attr"]) ? "css" : "yaml-only";
  return onlyHas(field, ["name", "type", "from", "regex"]) ? "regex" : "yaml-only";
}

/** The field reading from a regex, a JSONPath or a CSS selector. One capture group gives one value, so a regex can't fill an array. */
export function fieldReading(field: Record<string, unknown>, part: "regex" | "jsonpath" | "css") {
  const { name, type } = field;
  if (part === "jsonpath") return { name, type, jsonpath: "" };
  if (part === "css") return { name, type, css: "" };
  return { name, type: type === "integer" ? type : "string", from: "title", regex: "" };
}

/** The Condition with one more part, by default a test: added to a group, or grouped with a lone part. */
export function addPart(node: unknown, part: unknown = blankTest) {
  if (isMap(node)) {
    if (isList(node.all)) return { all: [...node.all, part] };
    if (isList(node.any)) return { any: [...node.any, part] };
  }
  return { all: [node, part] };
}

/** The part with `not` around it, or without the one it has. */
export function negate(node: unknown) {
  return isMap(node) && conditionPart(node) === "not" ? node.not : { not: node };
}

/** The predicate under another operator, keeping its value where that operator can hold it. */
export function changeOp(predicate: Record<string, unknown>, op: string): Record<string, unknown> {
  const { field, value } = predicate;
  if (op === "exists") return { field, op };
  if (op === "in") {
    if (isList(value)) return { field, op, value };
    // A blank value is nothing typed yet, and as an entry it would pass validation unseen.
    return { field, op, value: value === undefined || value === "" ? [] : [value] };
  }
  const single: unknown = isList(value) ? value[0] : value;
  if (op === "contains" || op === "matches") return { field, op, value: textOf(single) };
  return { field, op, value: single ?? "" };
}

/**
 * What a predicate's text box holds as a value. `gte` and `lte` take numbers, and text the form
 * can't make one of stays as typed, for the server to refuse. `contains` and `matches` take only
 * text. `is` takes text, but on a number field or for a number from the YAML view it takes a number,
 * since "4" never equals 4. Only text that round-trips counts, so typing "4.05" survives passing
 * through "4.0".
 */
export function typedValue(op: string, previous: unknown, text: string, numeric = false): string | number {
  const wantsNumber =
    op === "gte" ||
    op === "lte" ||
    ((numeric || typeof previous === "number") && op !== "contains" && op !== "matches");
  return wantsNumber && /^-?\d/.test(text) && String(Number(text)) === text ? Number(text) : text;
}

/** Whether a field holds numbers: the Rating, or a field an Extractor Rule declares as whole numbers. */
export function isNumericField(field: unknown, declared: readonly DeclaredField[]) {
  if (field === "severity" || field === "importance") return true;
  const type = declared.find(({ name }) => `fields.${name}` === field)?.type;
  return type === "integer" || type === "integer-array";
}

/**
 * The predicate on another field, with an operator and a value that can hold on it: `contains` never
 * holds on a number, `gte` never holds on text, and "4" never equals 4.
 */
export function changeField(predicate: Record<string, unknown>, field: string, numeric: boolean) {
  const op = textOf(predicate.op);
  const misfit = numeric ? op === "contains" || op === "matches" : op === "gte" || op === "lte";
  const { value, op: nextOp } = misfit ? changeOp(predicate, numeric ? "gte" : "contains") : predicate;
  const retyped = (entry: unknown) => (numeric ? typedValue(textOf(nextOp), undefined, textOf(entry), true) : textOf(entry));
  if (value === undefined) return { field, op: nextOp };
  return { field, op: nextOp, value: isList(value) ? value.map(retyped) : retyped(value) };
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

const formKeys: Record<Exclude<RuleType, "action">, Record<RuleKind, string[]>> = {
  classifier: {
    deterministic: ["classifier", "when", "assign"],
    agent: ["classifier", "prompt", "categories"],
  },
  extractor: {
    deterministic: ["extractor", "when", "fields"],
    agent: ["extractor", "when", "prompt", "fields"],
  },
};

function keysInForm(draft: Draft) {
  const type = ruleTypeOf(draft);
  if (type !== "action") return formKeys[type][kindOf(draft)];
  return ["action", "when", "kind", "destinations", ...(draft.kind === "digest" ? ["schedule"] : [])];
}

/** The rule's top-level keys the form has no control for. They stay in the draft. */
export function formHides(draft: Draft) {
  const shown = keysInForm(draft);
  return Object.entries(draft)
    .filter(([key, value]) => {
      if (!shown.includes(key)) return true;
      if (key === "when") return false;
      if (key === "assign" || key === "categories" || key === "destinations") return !isScalarList(value);
      if (key === "fields") return !isList(value);
      return !isScalar(value);
    })
    .map(([key]) => key);
}

const placedInForm = [
  /^(?:classifier|extractor|action|kind|schedule|prompt|(?:assign|categories|destinations)(?:\.\d+)?|fields(?:\.\d+(?:\.(?:name|type|from|regex|jsonpath|css|attr))?)?)$/,
  /^when(?:\.(?:all|any)\.\d+|\.not)*(?:\.(?:all|any|field|op|value(?:\.\d+)?))?$/,
];

/** Whether the form has a place beside a field for a problem at this path. The rest go in a summary. */
export const formShows = (path: string) => placedInForm.some((place) => place.test(path));
