/**
 * Whether an id from a URL or a form is a uuid. Check before querying: Postgres refuses a malformed
 * uuid with an error rather than matching nothing.
 */
export const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
