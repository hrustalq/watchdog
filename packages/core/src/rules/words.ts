// A Condition in words, for an alert's "why it fired" and the Rules list (docs: Actions and delivery,
// "Alerts"). Only `is` and `in` values go unquoted: a pattern or a substring reads badly bare.
import type { Condition, Predicate } from "./schema.ts";

const extracted = "fields.";

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function fieldWords(field: string) {
  if (field.startsWith(extracted)) return `Field ${field.slice(extracted.length)}`;
  if (field === "source.type") return "Source type";
  return field === "url" ? "URL" : capitalized(field);
}

/**
 * Negated by wording, never by turning the test around: "not at least 4" holds on a missing field
 * and "below 4" wouldn't, so "is not at least 4" is what `not` means here.
 */
function predicateWords(predicate: Predicate, negated: boolean) {
  const name = fieldWords(predicate.field);
  const is = negated ? "is not" : "is";
  switch (predicate.op) {
    case "is":
      return `${name} ${is} ${String(predicate.value)}`;
    case "in":
      return `${name} ${is} ${predicate.value.length > 1 ? "one of " : ""}${predicate.value.join(", ")}`;
    case "contains":
      return `${name} ${negated ? "doesn't contain" : "contains"} "${predicate.value}"`;
    case "matches":
      return `${name} ${negated ? "doesn't match" : "matches"} "${predicate.value}"`;
    case "gte":
      return `${name} ${is} at least ${String(predicate.value)}`;
    case "lte":
      return `${name} ${is} at most ${String(predicate.value)}`;
    case "exists":
      return `${name} ${is} present`;
  }
}

/** The node with any group of one replaced by its only part, which means the same. */
function withoutLoneGroups(node: Condition): Condition {
  if (!("all" in node || "any" in node)) return node;
  const parts = "all" in node ? node.all : node.any;
  const [only] = parts;
  return only !== undefined && parts.length === 1 ? withoutLoneGroups(only) : node;
}

/** A part of a group, in brackets when it is a group too. */
function partWords(part: Condition) {
  const node = withoutLoneGroups(part);
  return "all" in node || "any" in node ? `(${nodeWords(node)})` : nodeWords(node);
}

function nodeWords(condition: Condition): string {
  const node = withoutLoneGroups(condition);
  if ("all" in node) return node.all.map(partWords).join(" and ");
  if ("any" in node) return node.any.map(partWords).join(" or ");
  if (!("not" in node)) return predicateWords(node, false);
  const negated = withoutLoneGroups(node.not);
  return "field" in negated ? predicateWords(negated, true) : `not (${nodeWords(negated)})`;
}

/** A Condition that passed `conditionSchema`, as one sentence. */
export function conditionToWords(condition: Condition) {
  return capitalized(nodeWords(condition));
}
