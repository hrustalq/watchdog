// The capture stage: one poll of a Source turns new feed entries into Items
// (docs: Processing pipeline, "Stages").
import { and, type Db, eq, inArray, item, itemLog, source, type Tx } from "@watchdog/db";
import type { ItemDraft } from "../sources/item.ts";
import { fetchFeed, type FetchFeedDeps } from "../sources/rss/fetch-feed.ts";
import { detectLanguage } from "./language.ts";

export interface PollSourceDeps extends FetchFeedDeps {
  now?: () => Date;
  /**
   * Queues new Items' pipeline jobs over the transaction that inserts them, so a worker dying after
   * the commit can't lose an Item, and a rolled-back capture leaves no job.
   */
  enqueueItems: (tx: Tx, itemIds: string[]) => Promise<void>;
}

export type PollResult = { captured: number } | { error: string };

// A new Source's first fetch captures at most this many entries from this far back.
const backfillMax = 50;
const backfillWindow = 7 * 24 * 60 * 60 * 1000;

/** When an entry was published; an undated one counts as just published. */
const published = (entry: ItemDraft) => entry.publishedAt?.getTime() ?? Infinity;

/**
 * Fetches a Source, captures its new entries as Items, and records the outcome on the Source.
 * A failed fetch is stored as the Source's last error, not thrown, so the next poll retries.
 */
export async function pollSource(
  db: Db,
  sourceId: string,
  deps: PollSourceDeps,
): Promise<PollResult> {
  const found = await db.query.source.findFirst({ where: eq(source.id, sourceId) });
  // Only RSS Sources poll until the other Schedule types have fetches of their own.
  if (found?.type !== "rss" || !("url" in found.config)) return { captured: 0 };
  const fetchedAt = deps.now?.() ?? new Date();

  let fetched;
  try {
    fetched = await fetchFeed(found.config.url, found.fetchState, deps);
  } catch (error) {
    const message = describe(error);
    await db
      .update(source)
      .set({ lastError: message, lastErrorAt: fetchedAt })
      .where(eq(source.id, sourceId));
    return { error: message };
  }
  const succeeded = { lastPolledAt: fetchedAt, lastError: null, lastErrorAt: null };
  if ("notModified" in fetched) {
    await db.update(source).set(succeeded).where(eq(source.id, sourceId));
    return { captured: 0 };
  }

  const byId = new Map(fetched.entries.map(withoutNul).map((entry) => [entry.externalId, entry]));
  const entries = [...byId.values()];
  // The row lock makes concurrent polls of one Source take turns, so only one takes the Backfill.
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(source).where(eq(source.id, sourceId)).for("update");
    if (locked === undefined) return { captured: 0 };

    const { backfilledAt } = locked;
    let capture: ItemDraft[];
    let backfill = {};
    if (backfilledAt === null) {
      const start = fetchedAt.getTime() - backfillWindow;
      capture = entries
        .filter((entry) => entry.publishedAt !== null && published(entry) >= start)
        .sort((a, b) => published(b) - published(a))
        .slice(0, backfillMax);
      // Remembered by ID, not by date: an old Atom entry whose <updated> moves stays out.
      const taken = new Set(capture);
      const skipped = entries.filter((entry) => !taken.has(entry)).map((e) => e.externalId);
      backfill = { backfilledAt: fetchedAt, backfillSkippedIds: skipped };
    } else {
      const start = backfilledAt.getTime() - backfillWindow;
      const skipped = new Set(locked.backfillSkippedIds ?? []);
      const candidates = entries.filter(
        (entry) => !skipped.has(entry.externalId) && published(entry) >= start,
      );
      // Most of a feed is already captured: only new entries go on to language detection.
      const stored =
        candidates.length === 0
          ? []
          : await tx
              .select({ externalId: item.externalId })
              .from(item)
              .where(
                and(
                  eq(item.sourceId, sourceId),
                  inArray(
                    item.externalId,
                    candidates.map((entry) => entry.externalId),
                  ),
                ),
              );
      const known = new Set(stored.map((row) => row.externalId));
      capture = candidates.filter((entry) => !known.has(entry.externalId));
    }

    const isBackfill = backfilledAt === null;
    const inserted =
      capture.length === 0
        ? []
        : await tx
            .insert(item)
            .values(
              capture.map((entry) => ({
                ...entry,
                workspaceId: locked.workspaceId,
                sourceId,
                language: detectLanguage(`${entry.title ?? ""} ${entry.body}`),
                isBackfill,
              })),
            )
            .onConflictDoNothing({ target: [item.sourceId, item.externalId] })
            .returning({ id: item.id });
    if (inserted.length > 0) {
      const message = `Captured from ${locked.name}${isBackfill ? " as part of the Backfill" : ""}`;
      const data = { sourceId, fetchedAt: fetchedAt.toISOString() };
      const stage = "capture" as const;
      const rows = inserted.map(({ id }) => ({ itemId: id, stage, message, data }));
      await tx.insert(itemLog).values(rows);
      await deps.enqueueItems(
        tx,
        inserted.map(({ id }) => id),
      );
    }
    // FetchState is an interface, so it lacks the index signature the column's type has. A copy
    // of it has one.
    await tx
      .update(source)
      .set({ ...succeeded, fetchState: { ...fetched.fetchState }, ...backfill })
      .where(eq(source.id, sourceId));
    return { captured: inserted.length };
  });
}

/** The error for the user. fetch's TypeError says only "fetch failed"; its cause says why. */
function describe(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  const { cause } = error;
  return error instanceof TypeError && cause instanceof Error
    ? `${error.message}: ${cause.message}`
    : error.message;
}

/** The entry without U+0000, which a feed can carry but Postgres text and jsonb refuse. */
function withoutNul(entry: ItemDraft): ItemDraft {
  const strip = (text: string) => text.replaceAll("\0", "");
  const raw: unknown = JSON.parse(
    JSON.stringify(entry.raw, (_key, value: unknown) =>
      typeof value === "string" ? strip(value) : value,
    ),
  );
  return {
    ...entry,
    externalId: strip(entry.externalId),
    url: entry.url === null ? null : strip(entry.url),
    title: entry.title === null ? null : strip(entry.title),
    author: entry.author === null ? null : strip(entry.author),
    body: strip(entry.body),
    raw: typeof raw === "object" && raw !== null ? raw : {},
  };
}
