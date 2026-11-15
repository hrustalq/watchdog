// Text a Postgres text or jsonb column can hold: no NUL, and no lone surrogate, which UTF-8 replaces
// with U+FFFD. Both arrive from feeds and JSON payloads.
import { withoutNul } from "../without-nul/index.ts";

export function storableText(value: string): string {
  return withoutNul(value).toWellFormed();
}
