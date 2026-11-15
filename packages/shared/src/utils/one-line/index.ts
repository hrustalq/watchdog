import { withoutNul } from "../without-nul/index.ts";

/**
 * A name or a term on one line: no NUL, each run of whitespace one space, trimmed, and cut to `max`
 * characters when one is given. An empty or blank value becomes an empty string, never null.
 */
export function oneLine(value: string, max?: number): string {
  const line = withoutNul(value).replace(/\s+/g, " ").trim();
  return max === undefined ? line : line.slice(0, max);
}
