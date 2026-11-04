// Rule JSONPaths (docs: Rule model, "JSONPath"). The only module that touches the library, so
// changing it means changing this file. json-p3 follows RFC 9535, whose filters are a small
// expression grammar with no way to reach JavaScript, because user-written paths run on a shared
// worker.
import { jsonpath, JSONPathEnvironment, type JSONValue } from "json-p3";

const env = new JSONPathEnvironment();
// These two run on JavaScript's backtracking RegExp, where one pattern can hang the worker. Rule
// regexes run on RE2 (ADR 0026), and a Source's data can supply the pattern here.
delete env.functions.match;
delete env.functions.search;

// A selector list repeats nodes, so lists multiply each other's results, `$..*..*` grows with the
// data's depth, and a filter holding another `$` walks all of `raw` for every node it tests. Counted
// in the text, so one of these in a filter's string counts too: that can only refuse a path, never
// let one through. These are tight because a later loosening breaks nothing, while a tightening
// would refuse rules already saved.
const maxLength = 1000;
const maxSelectorCommas = 2;
const maxDescendantSegments = 1;

/** The most values a field can hold. */
export const maxFieldValues = 1000;

const count = (text: string, part: string) => text.split(part).length - 1;

/** Why a rule can't read a field with this JSONPath, or undefined when it can. */
export function jsonPathError(path: string): string | undefined {
  if (path.length > maxLength) {
    return `A JSONPath can be at most ${String(maxLength)} characters.`;
  }
  if (count(path, ",") > maxSelectorCommas) {
    return `"${path}" has too many selectors: a path can have at most ${String(maxSelectorCommas)} commas.`;
  }
  if (count(path, "..") > maxDescendantSegments) {
    return `"${path}" has too many descendant segments: a path can have ${String(maxDescendantSegments)} "..".`;
  }
  if (count(path, "$") > 1) {
    return `"${path}" goes back to the root inside a filter. Use @ there, for the node it tests.`;
  }
  try {
    env.compile(path);
    return undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `"${path}" isn't a JSONPath Watchdog can run: ${reason}`;
  }
}

/**
 * What a validated path finds in `raw`, or undefined when `raw` nests too deeply to walk. It stops
 * one value past `maxFieldValues`, so a path that multiplies its results can't fill the worker's
 * memory first.
 */
export function jsonPathValues(path: string, raw: unknown): unknown[] | undefined {
  const values: unknown[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- it came out of a jsonb column
    for (const value of env.findAllIter(path, raw as JSONValue)) {
      values.push(value);
      if (values.length > maxFieldValues) break;
    }
    return values;
  } catch (error) {
    if (error instanceof jsonpath.JSONPathRecursionError) return undefined;
    throw error;
  }
}
