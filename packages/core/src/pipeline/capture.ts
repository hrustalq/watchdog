// The capture stage: one poll of a Source turns new feed entries into Items
// (docs: Processing pipeline, "Stages").
import { type Db, eq, item, itemLog, source } from "@watchdog/db";
import type { ItemDraft } from "../sources/item.ts";
import { fetchFeed, type FetchFeedDeps } from "../sources/rss/fetch-feed.ts";
import { detectLanguage } from "./language.ts";

export interface PollSourceDeps extends FetchFeedDeps {
  now?: () => Date;
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
  if (found === undefined) return { captured: 0 };
  const fetchedAt = deps.now?.() ?? new Date();

  let fetched;
  try {
    fetched = await fetchFeed(found.config.url, found.fetchState, deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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

  const entries = [...new Map(fetched.entries.map((entry) => [entry.externalId, entry])).values()];
  // The row lock makes concurrent polls of one Source take turns, so only one takes the Backfill.
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(source).where(eq(source.id, sourceId)).for("update");
    if (locked === undefined) return { captured: 0 };

    const { backfilledAt } = locked;
    const isBackfill = backfilledAt === null;
    let capture: ItemDraft[];
    let backfill = {};
    if (backfilledAt === null) {
      const start = fetchedAt.getTime() - backfillWindow;
      const recent = entries.filter((entry) => published(entry) >= start);
      capture = recent
        .filter((entry) => entry.publishedAt !== null)
        .sort((a, b) => published(b) - published(a))
        .slice(0, backfillMax);
      // Entries older than the window stay out by date; the recent ones left out, by ID.
      const skipped = recent.filter((entry) => !capture.includes(entry));
      backfill = { backfilledAt: fetchedAt, backfillSkippedIds: skipped.map((e) => e.externalId) };
    } else {
      const skipped = new Set(locked.backfillSkippedIds);
      capture = entries.filter(
        (entry) =>
          !skipped.has(entry.externalId) &&
          published(entry) >= backfilledAt.getTime() - backfillWindow,
      );
    }

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
