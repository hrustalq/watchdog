// The capture stage: drafts from any Source type become Items, whether a poll fetched them or a
// push delivered them (docs: Processing pipeline, "Stages").
import { and, type Db, eq, inArray, item, itemLog, source, type Tx } from "@watchdog/db";
import type { ItemDraft } from "../sources/item.ts";
import { type Backfill, type PollDeps, sourceTypes } from "../sources/types.ts";
import { detectLanguage } from "./language.ts";

export interface CaptureDeps {
  now?: () => Date;
  /**
   * Queues new Items' pipeline jobs over the transaction that inserts them, so a worker dying after
   * the commit can't lose an Item, and a rolled-back capture leaves no job.
   */
  enqueueItems: (tx: Tx, itemIds: string[]) => Promise<void>;
}

export interface PollSourceDeps extends PollDeps, CaptureDeps {}

export type PollResult = { captured: number } | { error: string };

/** A successful poll or push. A poll moves last_polled_at, and stores its fetch state if it has one. */
interface Success {
  at: Date;
  polled: boolean;
  fetchState?: object;
}

/** How a poll or push ended, as the Source records it. */
type Outcome = Success | { at: Date; error: string };

/** When a draft was published; an undated one counts as just published. */
const published = (draft: ItemDraft) => draft.publishedAt?.getTime() ?? Infinity;

/**
 * Polls a Source through its type, captures the new drafts as Items, and records the outcome on the
 * Source. A failed fetch is stored as the Source's last error, not thrown, so the next poll retries.
 */
export async function pollSource(
  db: Db,
  sourceId: string,
  deps: PollSourceDeps,
): Promise<PollResult> {
  const found = await db.query.source.findFirst({ where: eq(source.id, sourceId) });
  const type = found && sourceTypes[found.type];
  // A type with no poll of its own yet captures nothing.
  if (found === undefined || type?.poll === undefined) return { captured: 0 };
  const at = deps.now?.() ?? new Date();

  let polled;
  try {
    polled = await type.poll(found, deps);
  } catch (error) {
    const message = describe(error);
    await recordOutcome(db, sourceId, { at, error: message });
    return { error: message };
  }
  if ("notModified" in polled) {
    await recordOutcome(db, sourceId, { at, polled: true });
    return { captured: 0 };
  }
  const outcome = { at, polled: true, fetchState: polled.fetchState };
  return captureItems(db, sourceId, polled.drafts, { backfill: type.backfill, outcome }, deps);
}

/**
 * Captures drafts from any Source type as Items: the first capture takes the type's Backfill, a
 * draft already stored is skipped, and each new Item gets a capture Log row and its pipeline job.
 */
export async function captureItems(
  db: Db,
  sourceId: string,
  drafts: ItemDraft[],
  { backfill, outcome }: { backfill: Backfill | null; outcome: Success },
  deps: CaptureDeps,
): Promise<{ captured: number }> {
  const byId = new Map(drafts.map(withoutNul).map((draft) => [draft.externalId, draft]));
  const unique = [...byId.values()];
  const { at } = outcome;
  // The row lock makes concurrent captures of one Source take turns, so only one takes the Backfill.
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(source).where(eq(source.id, sourceId)).for("update");
    if (locked === undefined) return { captured: 0 };

    const { backfilledAt } = locked;
    const isBackfill = backfill !== null && backfilledAt === null;
    let capture: ItemDraft[];
    let backfillColumns = {};
    if (isBackfill) {
      const start = at.getTime() - backfill.window;
      capture = unique
        .filter((draft) => draft.publishedAt !== null && published(draft) >= start)
        .sort((a, b) => published(b) - published(a))
        .slice(0, backfill.max);
      // Remembered by ID, not by date: an old Atom entry whose <updated> moves stays out.
      const taken = new Set(capture);
      const skipped = unique.filter((draft) => !taken.has(draft)).map((d) => d.externalId);
      backfillColumns = { backfilledAt: at, backfillSkippedIds: skipped };
    } else {
      // A type without a Backfill captures every new draft, however old.
      const start = backfill && backfilledAt ? backfilledAt.getTime() - backfill.window : -Infinity;
      const skipped = new Set(locked.backfillSkippedIds ?? []);
      const candidates = unique.filter(
        (draft) => !skipped.has(draft.externalId) && published(draft) >= start,
      );
      // Most of a feed is already captured: only new drafts go on to language detection.
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
                    candidates.map((draft) => draft.externalId),
                  ),
                ),
              );
      const known = new Set(stored.map((row) => row.externalId));
      capture = candidates.filter((draft) => !known.has(draft.externalId));
    }

    const inserted =
      capture.length === 0
        ? []
        : await tx
            .insert(item)
            .values(
              capture.map((draft) => ({
                ...draft,
                workspaceId: locked.workspaceId,
                sourceId,
                language: detectLanguage(`${draft.title ?? ""} ${draft.body}`),
                isBackfill,
              })),
            )
            .onConflictDoNothing({ target: [item.sourceId, item.externalId] })
            .returning({ id: item.id });
    if (inserted.length > 0) {
      const message = `Captured from ${locked.name}${isBackfill ? " as part of the Backfill" : ""}`;
      const data = { sourceId, fetchedAt: at.toISOString() };
      const stage = "capture" as const;
      const rows = inserted.map(({ id }) => ({ itemId: id, stage, message, data }));
      await tx.insert(itemLog).values(rows);
      await deps.enqueueItems(
        tx,
        inserted.map(({ id }) => id),
      );
    }
    await recordOutcome(tx, sourceId, outcome, backfillColumns);
    return { captured: inserted.length };
  });
}

/**
 * Records how a poll or push of a Source ended. Every outcome comes through here, so Source Health
 * is kept in one place.
 */
async function recordOutcome(
  db: Db | Tx,
  sourceId: string,
  outcome: Outcome,
  also: { backfilledAt?: Date; backfillSkippedIds?: string[] } = {},
) {
  const set =
    "error" in outcome
      ? { lastError: outcome.error, lastErrorAt: outcome.at }
      : {
          lastError: null,
          lastErrorAt: null,
          ...(outcome.polled && { lastPolledAt: outcome.at }),
          // A fetch state type is an interface, so it lacks the index signature the column's type
          // has. A copy of it has one.
          ...(outcome.fetchState && { fetchState: { ...outcome.fetchState } }),
        };
  await db
    .update(source)
    .set({ ...set, ...also })
    .where(eq(source.id, sourceId));
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
