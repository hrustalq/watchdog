/**
 * Text without U+0000, which a feed or a JSON payload can carry but Postgres text and jsonb refuse.
 * Everything else, lone surrogates included, is left as it came in.
 */
export function withoutNul(value: string): string {
  return value.replaceAll("\0", "");
}
