/**
 * Whether a value is an object a caller can read named keys from. An array passes, as it does with a
 * bare `typeof` check, because a JSON value may be either; null, undefined and every primitive fail.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
