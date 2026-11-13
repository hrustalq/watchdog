// The Feed as the Workspace screen reads it, in its Top and Latest views (docs: Processing pipeline,
// "Feed"). Every query is scoped to the Workspace, so another Workspace's Item id behaves like a
// missing one.
import { localDateTime } from "@watchdog/core";
import {
  action,
  actionDestination,
  and,
  correction,
  type Db,
  delivery,
  desc,
  destination,
  digestItem,
  eq,
  isNotNull,
  item,
  itemCategory,
  itemLog,
  source,
  type SQL,
  sql,
} from "@watchdog/db";
import { isUuid } from "./uuid.ts";

export const feedPageSize = 50;

// The Latest order, which item_feed_idx serves: newest captured, then newest published with undated
// last, then id. Every key is non-null, so the keyset cursor is one row comparison.
const published = sql`coalesce(${item.publishedAt}, '-infinity')`;
const latestKey = sql`(${item.capturedAt}, ${published}, ${item.id})`;

// A cursor timestamp: UTC, every microsecond kept, and nothing a URL has to escape.
// node-postgres can't write a year past 9999. A BC date (a feed's bad date) loses its era here, which
// can only repeat such Items among themselves.
const stamp = (column: typeof item.capturedAt | typeof item.publishedAt) =>
  sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const stampPattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.\d{6}Z$/;

/** Whether text is a cursor timestamp for a real instant, so `::timestamptz` can't throw on it. */
function isStamp(text: string) {
  const seconds = stampPattern.exec(text)?.[1];
  // Postgres has no year 0, and a JS Date rolls a day that doesn't exist into the next month.
  if (seconds === undefined || seconds.startsWith("0000")) return false;
  const date = new Date(`${seconds}Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(seconds);
}

/**
 * The sort keys of a "Show older" cursor, `<captured_at>_<published_at or -infinity>_<id>`, or
 * undefined when the value isn't one. The cursor holds the keys rather than an Item id, so it
 * still marks its place after that Item is deleted.
 */
export function parseCursor(value: unknown) {
  if (typeof value !== "string") return undefined;
  const [captured = "", publishedAt = "", id = "", ...rest] = value.split("_");
  const valid =
    rest.length === 0 &&
    isStamp(captured) &&
    (publishedAt === "-infinity" || isStamp(publishedAt)) &&
    isUuid(id);
  return valid ? { captured, published: publishedAt, id } : undefined;
}

export type FeedCursor = NonNullable<ReturnType<typeof parseCursor>>;

/** The sort keys of a Top "Show older" cursor, `<top_score>_<captured_at>_<id>`, or undefined. */
export function parseTopCursor(value: unknown) {
  if (typeof value !== "string") return undefined;
  const [score = "", captured = "", id = "", ...rest] = value.split("_");
  const valid = rest.length === 0 && /^\d{1,2}$/.test(score) && isStamp(captured) && isUuid(id);
  return valid ? { score, captured, id } : undefined;
}

type TopCursor = NonNullable<ReturnType<typeof parseTopCursor>>;

/**
 * One page of rows in the given order, and the cursor for the page after it (null on the last).
 * The cursor is built in SQL from the last Item's keys, keeping captured_at's microseconds that a
 * JS Date drops, so "Show older" can't skip or repeat an Item as new ones arrive.
 */
async function readPage(db: Db, cursor: SQL<string>, where: SQL | undefined, order: SQL[]) {
  const rows = await db
    .select({
      id: item.id,
      title: item.title,
      sourceName: source.name,
      publishedAt: item.publishedAt,
      capturedAt: item.capturedAt,
      isBackfill: item.isBackfill,
      severity: item.severity,
      importance: item.importance,
      // In the page's one query, so a page of rows doesn't add a query per row.
      categories: sql<string[]>`array(
        select ${itemCategory.category} from ${itemCategory}
        where ${itemCategory.itemId} = ${item.id} order by ${itemCategory.category})`,
      // The summary once the Agent has written one. A row shows two lines at most, and either can be long.
      excerpt: sql<string>`left(coalesce(${item.summary}, ${item.body}), 300)`,
      // Whether the user was already told about it, so Top can show what's old news.
      // A webhook call tells a machine, not the user, so only a Telegram or email alert counts.
      alerted: sql<boolean>`exists(
        select 1 from ${delivery} join ${destination} on ${destination.id} = ${delivery.destinationId}
        where ${delivery.itemId} = ${item.id} and ${delivery.status} = 'sent'
          and ${destination.type} in ('telegram', 'email'))`,
      cursor,
    })
    .from(item)
    .innerJoin(source, eq(source.id, item.sourceId))
    .where(where)
    .orderBy(...order)
    .limit(feedPageSize + 1);
  const items = rows.slice(0, feedPageSize).map(({ cursor: _, ...row }) => row);
  const older = rows.length > feedPageSize ? (rows[feedPageSize - 1]?.cursor ?? null) : null;
  return { items, older };
}

/** One page of the Latest view, newest first. */
export function feedPage(db: Db, workspaceId: string, before?: FeedCursor) {
  const after =
    before === undefined
      ? undefined
      : sql`${latestKey} < (
          ${before.captured}::timestamptz, ${before.published}::timestamptz, ${before.id}::uuid)`;
  return readPage(
    db,
    // The last row's sort keys, in the shape parseCursor reads.
    sql<string>`concat_ws('_', ${stamp(item.capturedAt)},
      coalesce(${stamp(item.publishedAt)}, '-infinity'), ${item.id})`,
    and(eq(item.workspaceId, workspaceId), after),
    [desc(item.capturedAt), sql`${published} desc`, desc(item.id)],
  );
}

/**
 * One page of the Top view: rated Items captured in the last 7 days, highest top_score first, then
 * newest captured, then id. `fallback` means the Workspace has none, so this is Latest's first page
 * and `older` is a cursor for Latest. The keys are all non-null for a rated Item, so the keyset
 * cursor is one row comparison.
 */
export async function topPage(db: Db, workspaceId: string, before?: TopCursor) {
  const page = await readPage(
    db,
    sql<string>`concat_ws('_', ${item.topScore}, ${stamp(item.capturedAt)}, ${item.id})`,
    and(
      eq(item.workspaceId, workspaceId),
      isNotNull(item.topScore),
      sql`${item.capturedAt} >= now() - interval '7 days'`,
      before === undefined
        ? undefined
        : sql`(${item.topScore}, ${item.capturedAt}, ${item.id}) < (
            ${before.score}::smallint, ${before.captured}::timestamptz, ${before.id}::uuid)`,
    ),
    [desc(item.topScore), desc(item.capturedAt), desc(item.id)],
  );
  return page.items.length === 0 && before === undefined
    ? { ...(await feedPage(db, workspaceId)), fallback: true }
    : { ...page, fallback: false };
}

export type FeedItem = Awaited<ReturnType<typeof feedPage>>["items"][number];

interface LogRow {
  id: number;
  message: string;
  data: unknown;
}

const isManual = (row: LogRow): row is LogRow & { data: Record<string, unknown> } =>
  typeof row.data === "object" && row.data !== null && "manual" in row.data;

/** A field a manual run couldn't store, and why, as `storeExtraction` wrote it. */
interface RunProblem {
  name: string;
  reason: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** The names in one of a run's lists, and nothing else a row might hold there. */
const namesIn = (value: unknown) => (Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : []);

/** The fields a run couldn't store, each with the reason it gave. */
const problemsIn = (value: unknown): RunProblem[] =>
  Array.isArray(value)
    ? value.flatMap((entry: unknown) => {
        if (!isObject(entry)) return [];
        const { name, reason } = entry;
        return typeof name === "string" && typeof reason === "string" ? [{ name, reason }] : [];
      })
    : [];

/**
 * The manual run a URL names, from the Item's own Log, so a URL can only point at what this page
 * already shows. A provider's reason is too long and too private to go in the URL itself. Only the
 * newest run counts, so an old URL can't put a success above a later failure.
 *
 * The parts come from the row's data, which `storeExtraction` writes for what a rule filled, found
 * empty or couldn't store, and `manual-run` writes `detail` for a failure's reason — `reason` already
 * holds the call's failure type. A row from before `detail` carries its reason in its sentence alone,
 * so the page falls back to `message`.
 */
export function manualRunIn(log: LogRow[], runId: unknown) {
  const newest = log.findLast(isManual);
  if (newest === undefined || String(newest.id) !== runId) return undefined;
  const { extractor, fields, empty, problems, detail } = newest.data;
  return {
    id: newest.id,
    message: newest.message,
    failed: "failed" in newest.data,
    extractor: typeof extractor === "string" ? extractor : undefined,
    fields: namesIn(fields),
    empty: namesIn(empty),
    problems: problemsIn(problems),
    detail: typeof detail === "string" ? detail : undefined,
  };
}

export type ManualRun = NonNullable<ReturnType<typeof manualRunIn>>;

/** A failed send's Log row, which `deliver` marks with the next retry or as the last attempt. */
export function isActFailure({ stage, data }: { stage: string; data: unknown }) {
  if (stage !== "act" || typeof data !== "object" || data === null) return false;
  return "retryAt" in data || ("final" in data && data.final === true);
}

/** Whether a row's data holds a key, whatever shape the row was written with. */
const holds = (data: unknown, key: string) => typeof data === "object" && data !== null && Object.hasOwn(data, key);

/**
 * Whether a Log row records a failure, so the page can say so rather than leave it to colour. A stage
 * writes its call's `reason`, a failed manual run writes `failed`, and `deliver` marks a failed send with
 * the next retry or as the last attempt. A row already in the Log carries the same keys, so an old
 * failure reads as one too.
 */
export function isFailureRow({ stage, data }: { stage: string; data: unknown }) {
  return isActFailure({ stage, data }) || holds(data, "reason") || holds(data, "failed");
}

/**
 * Whether a failed row is a model call's, which the Model screen can fix, rather than a send's: the call's
 * reason is in the row, and a Delivery's row carries a reason of its own, so a send never counts.
 */
export function isCallFailure(row: { stage: string; data: unknown }) {
  return !isActFailure(row) && holds(row.data, "reason");
}

type Delivery = Pick<typeof delivery.$inferSelect, "status" | "attempts" | "nextAttemptAt" | "lastError">;

/**
 * Where a Delivery stands, in words. Times are in the Workspace timezone, as the Log's "Held until" and
 * "retrying at" say them, with the date and the zone, because a hold can run past midnight and the rest of
 * the page reads in UTC. Both sides format them with `localDateTime`, so one retry can't read two ways.
 * `last_error` holds Watchdog's own sentence, never a receiver's answer or a credential.
 */
export function deliveryStatus({ status, attempts, nextAttemptAt, lastError }: Delivery, timezone: string) {
  const at = (date: Date | null) => (date === null ? "a time not set" : localDateTime(date, timezone));
  // A sender's reason may end in a full stop already.
  const reason = (lastError ?? "no reason was recorded").replace(/\.$/, "");
  switch (status) {
    case "sent":
      return { text: "Sent", failed: false };
    case "held":
      return { text: `Held until ${at(nextAttemptAt)}`, failed: false };
    case "grouped":
      return { text: `Grouped, goes at ${at(nextAttemptAt)}`, failed: false };
    case "failed":
      return { text: `Failed: ${reason}. No more retries`, failed: true };
    case "queued":
      // A failed attempt's retry waits for its time. Without one, it was released from a hold and goes now.
      return attempts > 0 && nextAttemptAt !== null
        ? { text: `Failed: ${reason}. Next retry at ${at(nextAttemptAt)}`, failed: true }
        : { text: "Queued", failed: false };
  }
}

/**
 * Each Action that fired on an Item, oldest first, with its Destinations and how each Delivery stands,
 * read from the `delivery` table. A Digest has no Delivery per Item, so its Destinations show the Item
 * waiting in `digest_item`, and once sent, the Log rows the send wrote, because it deletes those rows: each
 * Destination it went to, and each that failed when another got it.
 * Empty when nothing fired, or the Item isn't this Workspace's.
 */
export async function itemActions(db: Db, workspaceId: string, itemId: string) {
  if (!isUuid(itemId)) return [];
  const [deliveries, digests, digestsSent] = await Promise.all([
    db
      .select({
        actionId: action.id,
        actionName: action.name,
        createdAt: action.createdAt,
        destination: destination.name,
        status: delivery.status,
        attempts: delivery.attempts,
        nextAttemptAt: delivery.nextAttemptAt,
        lastError: delivery.lastError,
        sentAt: delivery.sentAt,
      })
      .from(delivery)
      .innerJoin(action, eq(action.id, delivery.actionId))
      .innerJoin(destination, eq(destination.id, delivery.destinationId))
      .where(and(eq(delivery.itemId, itemId), eq(action.workspaceId, workspaceId)))
      .orderBy(action.createdAt, action.id, destination.name),
    db
      .select({
        actionId: action.id,
        actionName: action.name,
        createdAt: action.createdAt,
        destination: destination.name,
      })
      .from(digestItem)
      .innerJoin(action, eq(action.id, digestItem.actionId))
      .innerJoin(actionDestination, eq(actionDestination.actionId, action.id))
      .innerJoin(destination, eq(destination.id, actionDestination.destinationId))
      // A Digest only sends to confirmed Destinations, as the Act stage only collects for them.
      .where(and(eq(digestItem.itemId, itemId), eq(action.workspaceId, workspaceId), isNotNull(destination.confirmedAt)))
      .orderBy(action.createdAt, action.id, destination.name),
    db
      .select({
        actionId: action.id,
        actionName: action.name,
        createdAt: action.createdAt,
        destination: sql<string>`${itemLog.data}->>'destination'`,
        failed: sql<boolean>`${itemLog.data}->>'digest' = 'failed'`,
        reason: sql<string | null>`${itemLog.data}->>'reason'`,
        at: itemLog.at,
      })
      .from(itemLog)
      .innerJoin(action, sql`${action.id} = (${itemLog.data}->>'actionId')::uuid`)
      .where(
        and(
          eq(itemLog.itemId, itemId),
          eq(itemLog.stage, "act"),
          // A failure that waits for the next Digest has no `digest`: the Item still shows as waiting.
          sql`${itemLog.data}->>'digest' in ('sent', 'failed')`,
          eq(action.workspaceId, workspaceId),
        ),
      )
      .orderBy(action.createdAt, action.id, itemLog.at),
  ]);

  interface Fired {
    id: string;
    name: string;
    createdAt: Date;
    deliveries: typeof deliveries;
    digestTo: string[];
    digestSent: { destination: string; at: Date; failed: boolean; reason: string | null }[];
  }
  const fired = new Map<string, Fired>();
  const entry = ({ actionId: id, actionName: name, createdAt }: { actionId: string; actionName: string; createdAt: Date }) => {
    const found = fired.get(id) ?? { id, name, createdAt, deliveries: [], digestTo: [], digestSent: [] };
    fired.set(id, found);
    return found;
  };
  for (const row of deliveries) entry(row).deliveries.push(row);
  for (const row of digests) entry(row).digestTo.push(row.destination);
  for (const { destination: to, at, failed, reason, ...row } of digestsSent) {
    entry(row).digestSent.push({ destination: to, at, failed, reason });
  }
  return [...fired.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
}

/** A level on either axis, or null when the stored JSON holds something that isn't one. */
const levelIn = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;

/** The levels a Rating Correction started from, or undefined for a shape that isn't a Rating. */
function originalRating(before: unknown) {
  if (typeof before !== "object" || before === null) return undefined;
  const severity = "severity" in before ? before.severity : undefined;
  const importance = "importance" in before ? before.importance : undefined;
  return { severity: levelIn(severity), importance: levelIn(importance) };
}

/**
 * An Item's envelope with its Rating and summary, its Source's name, its Categories, its extracted
 * fields and its Log, oldest first, or undefined. A Rating Correction's `before` comes with it: it
 * keeps the Agent's own levels however many times the Rating is changed, so the scale can mark them.
 */
export async function itemWithLog(db: Db, workspaceId: string, itemId: string) {
  if (!isUuid(itemId)) return undefined;
  const [found, [corrected]] = await Promise.all([
    db.query.item.findFirst({
      where: and(eq(item.workspaceId, workspaceId), eq(item.id, itemId)),
      columns: { raw: false, workspaceId: false, sourceId: false, externalId: false },
      with: {
        source: { columns: { name: true } },
        categories: {
          columns: { category: true },
          orderBy: (row, { asc }) => [asc(row.category)],
        },
        fields: {
          columns: { name: true, value: true },
          with: { extractorRule: { columns: { name: true } } },
          orderBy: (field, { asc }) => [asc(field.name)],
        },
        log: {
          columns: { id: true, at: true, stage: true, message: true, data: true },
          orderBy: (log, { asc }) => [asc(log.at), asc(log.id)],
        },
      },
    }),
    db
      .select({ before: correction.before })
      .from(correction)
      .where(
        and(
          eq(correction.workspaceId, workspaceId),
          eq(correction.itemId, itemId),
          eq(correction.kind, "rating"),
        ),
      ),
  ]);
  if (found === undefined) return undefined;
  return { ...found, originalRating: corrected === undefined ? undefined : originalRating(corrected.before) };
}
