// Rule regexes (docs: Rule model, "Regular expressions"; ADR 0026). The only module that touches
// the engine, so changing engines means changing this file.
import { RE2JS } from "re2js";

// Match time is input length × program size, so linear time alone doesn't protect the worker.
const maxInstructions = 1000;

/** Why a rule can't use this regex, or undefined when it can. */
export function regexError(pattern: string): string | undefined {
  try {
    if (RE2JS.compile(pattern).programSize() <= maxInstructions) return undefined;
  } catch (error) {
    return `"${pattern}" isn't a regular expression Watchdog can run: ${String(error)}`;
  }
  return `"${pattern}" is too complex: it compiles to more than ${String(maxInstructions)} instructions.`;
}

/** Why a rule can't extract a field with this regex, or undefined when it can. */
export function captureRegexError(pattern: string): string | undefined {
  const error = regexError(pattern);
  if (error !== undefined) return error;
  return RE2JS.compile(pattern).groupCount() > 0
    ? undefined
    : `"${pattern}" has no capture group, so it can't extract a value.`;
}

/** Whether a validated pattern matches anywhere in the text. */
export function regexMatches(pattern: string, text: string) {
  return RE2JS.compile(pattern).test(text);
}

/** The first capture group of the first match of a validated pattern, if there is one. */
export function firstCapture(pattern: string, text: string) {
  const matcher = RE2JS.compile(pattern).matcher(text);
  return matcher.find() ? (matcher.group(1) ?? undefined) : undefined;
}
