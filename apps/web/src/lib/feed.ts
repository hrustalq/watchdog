// The Feed as the Workspace screen reads it, in the Latest view (docs: Processing pipeline, "Feed").
// Every query is scoped to the Workspace, so another Workspace's Item id behaves like a missing one.
import { and, type Db, desc, eq, item, source, sql } from "@watchdog/db";

export const feedPageSize = 50;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The Latest order, which item_feed_idx serves: newest captured, then newest published with undated
// last, then id. Every key is non-null, so the keyset cursor is one row comparison.
const published = sql`coalesce(${item.publishedAt}, '-infinity')`;
const latestKey = sql`(${item.capturedAt}, ${published}, ${item.id})`;

/**
 * One page of the Feed, newest first, and the cursor for the page after it (null on the last).
 * The cursor is the id of the page's last Item, so "Show older" can't skip or repeat an Item as new
 * ones arrive. Its sort keys are read back in SQL, keeping captured_at's microseconds a Date drops.
 */
export async function feedPage(db: Db, workspaceId: string, before?: string) {
  const after = before !== undefined && uuid.test(before)
    ? sql`${latestKey} < (
        select c.captured_at, coalesce(c.published_at, '-infinity'), c.id from item c
        where c.id = ${before} and c.workspace_id = ${workspaceId})`
    : undefined;
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
    })
    .from(item)
    .innerJoin(source, eq(source.id, item.sourceId))
    .where(and(eq(item.workspaceId, workspaceId), after))
    .orderBy(desc(item.capturedAt), sql`${published} desc`, desc(item.id))
    .limit(feedPageSize + 1);
  const items = rows.slice(0, feedPageSize);
  return { items, older: rows.length > feedPageSize ? (items.at(-1)?.id ?? null) : null };
}

export type FeedItem = Awaited<ReturnType<typeof feedPage>>["items"][number];

/** An Item's envelope with its Source's name and its Log, oldest first, or undefined. */
export function itemWithLog(db: Db, workspaceId: string, itemId: string) {
  // Postgres refuses a malformed uuid with an error rather than matching nothing.
  if (!uuid.test(itemId)) return Promise.resolve(undefined);
  return db.query.item.findFirst({
    where: and(eq(item.workspaceId, workspaceId), eq(item.id, itemId)),
    columns: { raw: false, summary: false, workspaceId: false, sourceId: false, externalId: false },
    with: {
      source: { columns: { name: true } },
      log: {
        columns: { id: true, at: true, stage: true, message: true },
        orderBy: (log, { asc }) => [asc(log.at), asc(log.id)],
      },
    },
  });
}
