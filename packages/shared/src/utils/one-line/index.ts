// A name or a term on one line: no NUL, each run of whitespace a single space, trimmed, and cut to the
// column's length when one is given.
import { withoutNul } from "../without-nul/index.ts";

export function oneLine(value: string, max?: number): string {
  const line = withoutNul(value).replace(/\s+/g, " ").trim();
  return max === undefined ? line : line.slice(0, max);
}
