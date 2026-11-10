// The webhook inbox: where an external system POSTs JSON to a webhook Source, and how its Inbox token
// is shown and replaced (docs: Actions and delivery, "Webhook inbox (intake)"; Security and privacy,
// "Source credentials").
import { createHash, randomBytes } from "node:crypto";
import { captureItems, type CaptureDeps, cleanPayload, decryptSecret, encryptSecret, webhookConfig, webhookDraft } from "@watchdog/core";
import { and, type Db, eq, isNotNull, item, source, sql } from "@watchdog/db";
import { isUuid } from "./uuid.ts";

const maxBodyBytes = 1024 * 1024;
const perMinute = 60;
/** application/json, or another +json type such as application/vnd.example+json. */
const jsonType = /^(?:application\/json|[\w.!#$&^-]+\/[\w.!#$&^+-]+\+json)$/;

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

/** A new Inbox token's columns: its hash to look requests up by, and the token until it's shown. */
export function newInboxToken(encryptionKey: Buffer) {
  const token = randomBytes(32).toString("base64url");
  return { inboxTokenHash: hashOf(token), secretCiphertext: encryptSecret(token, encryptionKey) };
}

export const inboxUrl = (baseURL: string, token: string) => new URL(`/api/inbox/${token}`, baseURL).href;

const answer = (status: number, body: object, headers: HeadersInit = {}) => Response.json(body, { status, headers });

/**
 * Answers one POST to an inbox, in the documented order: 401, 429, 415, 413, 400, then 202 when it
 * captures an Item or 200 when the Source already has it. Every request counts toward the limit.
 */
export async function receiveInbox(
  db: Db,
  deps: CaptureDeps & { now?: () => Date },
  token: string,
  request: Request,
): Promise<Response> {
  const at = deps.now?.() ?? new Date();
  const now = sql`${at.toISOString()}::timestamptz`;
  const inWindow = sql`${source.inboxWindowStart} > ${now} - interval '1 minute'`;
  // Looks the inbox up and counts the request in one statement, so concurrent requests count right.
  const [inbox] = await db
    .update(source)
    .set({
      inboxWindowStart: sql`case when ${inWindow} then ${source.inboxWindowStart} else ${now} end`,
      inboxWindowRequests: sql`case when ${inWindow} then ${source.inboxWindowRequests} + 1 else 1 end`,
      // A request isn't a change to the Source.
      updatedAt: sql`${source.updatedAt}`,
    })
    .where(and(eq(source.inboxTokenHash, hashOf(token)), eq(source.type, "webhook")))
    .returning({
      id: source.id,
      name: source.name,
      config: source.config,
      windowStart: source.inboxWindowStart,
      requests: source.inboxWindowRequests,
    });
  if (inbox === undefined) return answer(401, { error: "Unknown inbox" });
  if (inbox.requests > perMinute) {
    const resetsIn = (inbox.windowStart?.getTime() ?? at.getTime()) + 60_000 - at.getTime();
    return answer(
      429,
      { error: `This inbox takes at most ${String(perMinute)} requests a minute` },
      { "retry-after": String(Math.max(1, Math.ceil(resetsIn / 1000))) },
    );
  }
  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!jsonType.test(type)) {
    return answer(415, { error: "Send the body as JSON: Content-Type application/json or another +json type" });
  }
  const body = await readCapped(request);
  if (body === undefined) return answer(413, { error: "The body is over 1 MB" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return answer(400, { error: "The body isn't valid JSON" });
  }
  const payload = cleanPayload(parsed);
  if (payload === undefined) return answer(400, { error: "The JSON nests more than 100 levels deep" });

  const mapping = webhookConfig.safeParse(inbox.config).data?.mapping;
  const draft = webhookDraft(payload, body, inbox.name, mapping);
  const { captured } = await captureItems(db, inbox.id, [draft], { at, polled: false }, deps);
  // The payload is clean, so the external ID is stored as it is.
  const [found] = await db
    .select({ id: item.id })
    .from(item)
    .where(and(eq(item.sourceId, inbox.id), eq(item.externalId, draft.externalId)));
  // Only when the Source was removed while the request ran.
  if (found === undefined) return answer(401, { error: "Unknown inbox" });
  return answer(captured > 0 ? 202 : 200, { id: found.id });
}

/** The body's bytes, or undefined past 1 MB, counted as read so a false Content-Length doesn't help. */
async function readCapped(request: Request) {
  if (Number(request.headers.get("content-length")) > maxBodyBytes) return undefined;
  if (request.body === null) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Leaving the loop early cancels the stream.
  for await (const chunk of request.body) {
    size += chunk.byteLength;
    if (size > maxBodyBytes) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const isInbox = (workspaceId: string, sourceId: string) =>
  and(eq(source.workspaceId, workspaceId), eq(source.id, sourceId), eq(source.type, "webhook"));

/** The Workspace's inbox with this id, for its page, or undefined. */
export async function findInbox(db: Db, workspaceId: string, sourceId: string) {
  if (!isUuid(sourceId)) return undefined;
  const [found] = await db
    .select({ id: source.id, name: source.name, config: source.config })
    .from(source)
    .where(isInbox(workspaceId, sourceId));
  return found && { ...found, mapping: webhookConfig.safeParse(found.config).data?.mapping ?? {} };
}

/**
 * The inbox's token, the first time this is asked and never again: one UPDATE clears the ciphertext
 * and returns what it held, so only the hash is left. The page calls it while it renders, as the
 * Destinations page does a webhook secret.
 */
export async function revealInboxToken(db: Db, encryptionKey: Buffer, workspaceId: string, sourceId: string) {
  if (!isUuid(sourceId)) return undefined;
  const [shown] = await db
    .update(source)
    .set({ secretCiphertext: null })
    .where(and(isInbox(workspaceId, sourceId), isNotNull(source.secretCiphertext)))
    // Postgres 18's OLD: the value before this UPDATE cleared it.
    .returning({ ciphertext: sql<string>`old.secret_ciphertext` });
  return shown === undefined ? undefined : decryptSecret(shown.ciphertext, encryptionKey);
}

/** Gives the inbox a new token, for revealInboxToken to show once. The old one stops working at once. */
export async function replaceInboxToken(db: Db, encryptionKey: Buffer, workspaceId: string, sourceId: string) {
  if (!isUuid(sourceId)) return false;
  const replaced = await db
    .update(source)
    .set(newInboxToken(encryptionKey))
    .where(isInbox(workspaceId, sourceId))
    .returning({ id: source.id });
  return replaced.length > 0;
}
