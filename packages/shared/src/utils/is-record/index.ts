// A plain object, as opposed to null, an array or a primitive. An array passes, as it does with a
// bare `typeof` check, because a caller that reads named keys of a JSON value may hold either.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
