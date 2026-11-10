// A webhook inbox's payload as an Item (docs: Actions and delivery, "Webhook inbox (intake)").
import { createHash } from "node:crypto";
import type { SourceConfigs } from "@watchdog/db";
import { jsonPathError, jsonPathValues } from "../../rules/jsonpath.ts";
import { capBody, type ItemDraft } from "../item.ts";

export type WebhookMapping = NonNullable<SourceConfigs["webhook"]["mapping"]>;

/** Why an inbox can't map a field with this JSONPath, or undefined when it can. */
export const mappingError = jsonPathError;

/**
 * The Item a payload becomes. Each mapped field takes the first value its path finds; a path that
 * finds nothing, an object or an array leaves the field as if it had no mapping.
 */
export function webhookDraft(
  payload: unknown,
  body: Uint8Array,
  sourceName: string,
  mapping: { [Field in keyof WebhookMapping]?: string | undefined } = {},
): ItemDraft {
  const mapped = (field: keyof WebhookMapping) => {
    const path = mapping[field];
    if (path === undefined) return undefined;
    const [first] = jsonPathValues(path, payload) ?? [];
    return typeof first === "string" || typeof first === "number" || typeof first === "boolean"
      ? String(first)
      : undefined;
  };
  // The Item page links to it, so only a web URL is kept.
  const url = URL.parse(mapped("url") ?? "");
  return {
    externalId: mapped("externalId") ?? createHash("sha256").update(body).digest("hex"),
    url: url !== null && (url.protocol === "http:" || url.protocol === "https:") ? url.href : null,
    title: mapped("title") ?? `Webhook to ${sourceName}`,
    author: null,
    body: capBody(mapped("body") ?? JSON.stringify(payload, null, 2)),
    publishedAt: null,
    // A top-level scalar has nothing for a Rule's JSONPath to walk into.
    raw: typeof payload === "object" && payload !== null ? payload : {},
    captureNote: "It came through the webhook inbox",
  };
}
