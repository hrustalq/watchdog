// An Item's Corrections (docs: Processing pipeline, "Corrections"). Each one is a single transaction
// scoped to the Workspace, so another Workspace's Item id changes nothing. None of them enqueues
// anything: a Correction never fires an Action (Execution readiness session Q7).
import {
  and,
  correction,
  type Db,
  eq,
  isNotNull,
  item,
  itemCategory,
  itemLog,
  sql,
  type Tx,
} from "@watchdog/db";

const maxCategoryLength = 100;

/** Locks the Item, because a job can be storing an Agent's answer to it. */
async function lockItem(tx: Tx, workspaceId: string, itemId: string) {
  const [row] = await tx
    .select({
      id: item.id,
      workspaceId: item.workspaceId,
      title: item.title,
      summary: item.summary,
      severity: item.severity,
      importance: item.importance,
    })
    .from(item)
    .where(and(eq(item.workspaceId, workspaceId), eq(item.id, itemId)))
    .for("update");
  return row;
}

/** Writes the Correction and its Log row. A second one of a kind keeps the original `before`. */
async function record(
  tx: Tx,
  target: NonNullable<Awaited<ReturnType<typeof lockItem>>>,
  kind: "rating" | "categories",
  before: unknown,
  after: unknown,
  message: string,
) {
  const copies = { itemTitle: target.title, itemSummary: target.summary };
  await tx
    .insert(correction)
    .values({ workspaceId: target.workspaceId, itemId: target.id, kind, ...copies, before, after })
    .onConflictDoUpdate({
      target: [correction.itemId, correction.kind],
      targetWhere: isNotNull(correction.itemId),
      // The Agent reads the most recent Corrections by created_at, and this is the newest judgement.
      set: { ...copies, after, createdAt: sql`now()` },
    });
  // Back at the original, nothing is corrected, so a reverted misclick doesn't reach the Agent.
  await tx
    .delete(correction)
    .where(
      and(
        eq(correction.itemId, target.id),
        eq(correction.kind, kind),
        sql`${correction.before} = ${correction.after}`,
      ),
    );
  await tx.insert(itemLog).values({ itemId: target.id, stage: "correct", message, data: { kind, before, after } });
}

const ratingWords = ({ severity, importance }: { severity: number | null; importance: number | null }) =>
  severity === null || importance === null
    ? "Unrated"
    : `Severity ${String(severity)}, Importance ${String(importance)}`;

/**
 * Sets the axes given and keeps the other at its current level, so a page open for a while can't
 * undo a change to the axis it didn't touch. A Rating has both axes, so an unrated Item needs both.
 */
export function correctRating(
  db: Db,
  workspaceId: string,
  itemId: string,
  levels: { severity?: number | undefined; importance?: number | undefined },
) {
  return db.transaction(async (tx) => {
    const locked = await lockItem(tx, workspaceId, itemId);
    if (locked === undefined) return;
    const before = { severity: locked.severity, importance: locked.importance };
    const after = {
      severity: levels.severity ?? locked.severity,
      importance: levels.importance ?? locked.importance,
    };
    if (after.severity === null || after.importance === null) return;
    if (after.severity === before.severity && after.importance === before.importance) return;

    await tx
      .update(item)
      .set({ ...after, ratingCorrectedAt: sql`now()` })
      .where(eq(item.id, itemId));
    const message = `Corrected the Rating from ${ratingWords(before)} to ${ratingWords(after)}`;
    await record(tx, locked, "rating", before, after, message);
  });
}

/** Text the user typed, trimmed, or undefined when it can't be a Category. Postgres refuses a NUL. */
function categoryFrom(text: string) {
  const category = text.trim();
  return category === "" || category.length > maxCategoryLength || /\p{Cc}/u.test(category) ? undefined : category;
}

const categoryWords = (categories: string[]) => (categories.length === 0 ? "none" : categories.join(", "));

/** Adds or removes one Category. What it adds names no Classifier, because the user assigned it. */
export function correctCategories(
  db: Db,
  workspaceId: string,
  itemId: string,
  change: { add: string } | { remove: string },
) {
  return db.transaction(async (tx) => {
    const locked = await lockItem(tx, workspaceId, itemId);
    if (locked === undefined) return;
    const rows = await tx
      .select({ category: itemCategory.category })
      .from(itemCategory)
      .where(eq(itemCategory.itemId, itemId));
    const current = rows.map((row) => row.category).sort();

    let categories: string[];
    if ("add" in change) {
      const added = categoryFrom(change.add);
      if (added === undefined || current.includes(added)) return;
      await tx.insert(itemCategory).values({ itemId, category: added });
      categories = [...current, added].sort();
    } else {
      if (!current.includes(change.remove)) return;
      await tx
        .delete(itemCategory)
        .where(and(eq(itemCategory.itemId, itemId), eq(itemCategory.category, change.remove)));
      categories = current.filter((category) => category !== change.remove);
    }

    await tx.update(item).set({ categoriesCorrectedAt: sql`now()` }).where(eq(item.id, itemId));
    await record(
      tx,
      locked,
      "categories",
      { categories: current },
      { categories },
      `Corrected the Categories from ${categoryWords(current)} to ${categoryWords(categories)}`,
    );
  });
}
