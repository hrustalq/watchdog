// The Feed as the Workspace screen reads it, in the Latest view (docs: Processing pipeline, "Feed").
// Every query is scoped to the Workspace, so another Workspace's Item id behaves like a missing one.
import { and, type Db, desc, eq, item, source, sql } from "@watchdog/db";
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

/**
 * One page of the Feed, newest first, and the cursor for the page after it (null on the last).
 * The cursor is built in SQL from the last Item's keys, keeping captured_at's microseconds that a
 * JS Date drops, so "Show older" can't skip or repeat an Item as new ones arrive.
 */
export async function feedPage(db: Db, workspaceId: string, before?: FeedCursor) {
  const after =
    before === undefined
      ? undefined
      : sql`${latestKey} < (
          ${before.captured}::timestamptz, ${before.published}::timestamptz, ${before.id}::uuid)`;
  const rows = await db
    .select({
      id: item.id,
      title: item.title,
      sourceName: source.name,
      publishedAt: item.publishedAt,
      capturedAt: item.capturedAt,
      isBackfill: item.isBackfill,
      // A row shows one or two lines of it, and body can be 32 KB.
      excerpt: sql<string>`left(${item.body}, 300)`,
      // The last row's sort keys, in the shape parseCursor reads.
      cursor: sql<string>`concat_ws('_', ${stamp(item.capturedAt)},
        coalesce(${stamp(item.publishedAt)}, '-infinity'), ${item.id})`,
    })
    .from(item)
    .innerJoin(source, eq(source.id, item.sourceId))
    .where(and(eq(item.workspaceId, workspaceId), after))
    .orderBy(desc(item.capturedAt), sql`${published} desc`, desc(item.id))
    .limit(feedPageSize + 1);
  const items = rows.slice(0, feedPageSize).map(({ cursor: _, ...row }) => row);
  const older = rows.length > feedPageSize ? (rows[feedPageSize - 1]?.cursor ?? null) : null;
  return { items, older };
}

export type FeedItem = Awaited<ReturnType<typeof feedPage>>["items"][number];

/**
 * The manual run a URL names, from the Item's own Log, so a URL can only point at what this page
 * already shows. A provider's reason is too long and too private to go in the URL itself.
 */
export function manualRunIn(log: { id: number; message: string; data: unknown }[], runId: unknown) {
  const row = log.find(({ id }) => String(id) === runId);
  const data = row?.data;
  if (row === undefined || typeof data !== "object" || data === null || !("manual" in data)) return undefined;
  return { id: row.id, message: row.message, failed: "failed" in data };
}

/** An Item's envelope with its Source's name, its extracted fields and its Log, oldest first, or undefined. */
export function itemWithLog(db: Db, workspaceId: string, itemId: string) {
  if (!isUuid(itemId)) return Promise.resolve(undefined);
  return db.query.item.findFirst({
    where: and(eq(item.workspaceId, workspaceId), eq(item.id, itemId)),
    columns: { raw: false, summary: false, workspaceId: false, sourceId: false, externalId: false },
    with: {
      source: { columns: { name: true } },
      fields: {
        columns: { name: true, value: true },
        orderBy: (field, { asc }) => [asc(field.name)],
      },
      log: {
        columns: { id: true, at: true, stage: true, message: true, data: true },
        orderBy: (log, { asc }) => [asc(log.at), asc(log.id)],
      },
    },
  });
}
