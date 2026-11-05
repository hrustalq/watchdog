// The Feed as the Workspace screen reads it, in its Top and Latest views (docs: Processing pipeline,
// "Feed"). Every query is scoped to the Workspace, so another Workspace's Item id behaves like a
// missing one.
import { and, type Db, desc, eq, isNotNull, item, itemCategory, source, type SQL, sql } from "@watchdog/db";
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

const isManual = (row: LogRow): row is LogRow & { data: object } =>
  typeof row.data === "object" && row.data !== null && "manual" in row.data;

/**
 * The manual run a URL names, from the Item's own Log, so a URL can only point at what this page
 * already shows. A provider's reason is too long and too private to go in the URL itself. Only the
 * newest run counts, so an old URL can't put a success above a later failure.
 */
export function manualRunIn(log: LogRow[], runId: unknown) {
  const newest = log.findLast(isManual);
  if (newest === undefined || String(newest.id) !== runId) return undefined;
  return { id: newest.id, message: newest.message, failed: "failed" in newest.data };
}

/**
 * An Item's envelope with its Rating and summary, its Source's name, its Categories, its extracted
 * fields and its Log, oldest first, or undefined.
 */
export function itemWithLog(db: Db, workspaceId: string, itemId: string) {
  if (!isUuid(itemId)) return Promise.resolve(undefined);
  return db.query.item.findFirst({
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
  });
}
