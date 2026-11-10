// The capture stage: drafts from any Source type become Items, whether a poll fetched them or a
// push delivered them (docs: Processing pipeline, "Stages").
import { and, type Db, eq, inArray, item, itemLog, source, sql, type Tx } from "@watchdog/db";
import { queueSourceAlerts } from "../delivery/source-alert.ts";
import { failingPollGapMs, healthAfter } from "../sources/health.ts";
import type { ItemDraft } from "../sources/item.ts";
import { type PollDeps, sourceTypes } from "../sources/types.ts";
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

export type PollResult = { captured: number } | { error: string } | { deferredUntil: Date };

/** A successful poll or push. A poll moves last_polled_at, and stores its fetch state if it has one. */
interface Success {
  at: Date;
  polled: boolean;
  fetchState?: Record<string, string>;
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
    polled = await type.poll(found, { ...deps, db, now: at });
  } catch (error) {
    // A poll stopped with the worker isn't the Source's failure: pg-boss retries the job.
    if (deps.signal?.aborted === true) throw error;
    const message = describe(error);
    await db.transaction((tx) => recordOutcome(tx, sourceId, { at, error: message }));
    return { error: message };
  }
  if ("deferUntil" in polled) {
    // A rate limit puts the poll off: no failure, no success, just a later next poll.
    const until = polled.deferUntil;
    await db
      .update(source)
      .set({ nextPollAt: sql`greatest(${source.nextPollAt}, ${until.toISOString()}::timestamptz)` })
      .where(eq(source.id, sourceId));
    return { deferredUntil: until };
  }
  if ("notModified" in polled) {
    await db.transaction((tx) => recordOutcome(tx, sourceId, { at, polled: true }));
    return { captured: 0 };
  }
  const outcome = { at, polled: true, fetchState: polled.fetchState };
  return captureItems(db, sourceId, polled.drafts, outcome, deps);
}

/**
 * Captures drafts from any Source type as Items: the first capture takes the type's Backfill, a
 * draft already stored is skipped, and each new Item gets a capture Log row and its pipeline job.
 * A push type's receiver calls it with a non-poll outcome.
 */
export async function captureItems(
  db: Db,
  sourceId: string,
  drafts: ItemDraft[],
  outcome: Success,
  deps: CaptureDeps,
): Promise<{ captured: number }> {
  const byId = new Map(drafts.map(withoutNul).map((draft) => [draft.externalId, draft]));
  const unique = [...byId.values()];
  const { at } = outcome;
  // The row lock makes concurrent captures of one Source take turns, so only one takes the Backfill.
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(source).where(eq(source.id, sourceId)).for("update");
    if (locked === undefined) return { captured: 0 };

    const rule = sourceTypes[locked.type]?.backfill ?? null;
    const backfill = typeof rule === "function" ? rule(locked.config) : rule;
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
              capture.map(({ captureNote: _, ...draft }) => ({
                ...draft,
                workspaceId: locked.workspaceId,
                sourceId,
                language: detectLanguage(`${draft.title ?? ""} ${draft.body}`),
                isBackfill,
              })),
            )
            .onConflictDoNothing({ target: [item.sourceId, item.externalId] })
            .returning({ id: item.id, externalId: item.externalId });
    if (inserted.length > 0) {
      const message = `Captured from ${locked.name}${isBackfill ? " as part of the Backfill" : ""}`;
      const notes = new Map(capture.map((draft) => [draft.externalId, draft.captureNote]));
      const data = { sourceId, fetchedAt: at.toISOString() };
      const stage = "capture" as const;
      const rows = inserted.map(({ id, externalId }) => {
        const note = notes.get(externalId);
        return { itemId: id, stage, message: note === undefined ? message : `${message}. ${note}`, data };
      });
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
 * Records how a poll or push of a Source ended, and what that makes its Health (docs: Sources and
 * ingestion, "Source Health"). Every outcome comes through here. A Source that becomes failing, or
 * recovers from it, alerts once, in this transaction.
 */
async function recordOutcome(
  tx: Tx,
  sourceId: string,
  outcome: Outcome,
  also: { backfilledAt?: Date; backfillSkippedIds?: string[] } = {},
) {
  const [before] = await tx.select().from(source).where(eq(source.id, sourceId)).for("update");
  if (before === undefined) return;
  const error = "error" in outcome ? outcome.error : null;
  const after = healthAfter(before, { at: outcome.at, failed: error !== null });
  // Only a poll fails here, so only a Schedule Source, which has a next poll, is put off.
  const nextHourly = new Date(outcome.at.getTime() + failingPollGapMs).toISOString();
  const set =
    "error" in outcome
      ? {
          lastError: outcome.error,
          lastErrorAt: outcome.at,
          ...(after.health === "failing" && {
            nextPollAt: sql`greatest(${source.nextPollAt}, ${nextHourly}::timestamptz)`,
          }),
        }
      : {
          lastError: null,
          lastErrorAt: null,
          ...(outcome.polled && { lastPolledAt: outcome.at }),
          ...(outcome.fetchState && { fetchState: outcome.fetchState }),
        };
  await tx
    .update(source)
    .set({ ...set, ...after, ...also })
    .where(eq(source.id, sourceId));
  if ((before.health === "failing") === (after.health === "failing")) return;
  await queueSourceAlerts(tx, [before], after.health === "failing" ? "failing" : "recovered", error);
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
