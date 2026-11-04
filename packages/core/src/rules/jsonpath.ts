// Rule JSONPaths (docs: Rule model, "JSONPath"). The only module that touches the library, so
// changing it means changing this file. json-p3 follows RFC 9535, whose filters are a small
// expression grammar with no way to reach JavaScript, because user-written paths run on a shared
// worker.
import { JSONPathEnvironment, JSONPathError, type JSONValue } from "json-p3";

const env = new JSONPathEnvironment();
// These two run on JavaScript's backtracking RegExp, where one pattern can hang the worker. Rule
// regexes run on RE2 (ADR 0026), and a Source's data can supply the pattern here.
delete env.functions.match;
delete env.functions.search;

// A selector list repeats nodes, so lists multiply each other's results, and `$..*..*` grows with
// the data's depth. Counted in the text, so a comma in a filter's string counts too: that can only
// refuse a path, never let one through.
const maxLength = 1000;
const maxSelectorCommas = 4;
const maxDescendantSegments = 2;

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
    return `"${path}" has too many descendant segments: a path can have at most ${String(maxDescendantSegments)} "..".`;
  }
  try {
    env.compile(path);
    return undefined;
  } catch (error) {
    return `"${path}" isn't a JSONPath Watchdog can run: ${String(error)}`;
  }
}

/** What a validated path finds in `raw`, or undefined when `raw` nests too deeply to walk. */
export function jsonPathValues(path: string, raw: unknown): unknown[] | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- it came out of a jsonb column
    return env.findAll(path, raw as JSONValue);
  } catch (error) {
    if (error instanceof JSONPathError) return undefined;
    throw error;
  }
}
