// The Act stage: which Actions fire for an Item that finished the pipeline (docs: Processing pipeline,
// "The Act stage"; Actions and delivery, "Deliveries").
import {
  action,
  actionDestination,
  and,
  type Db,
  delivery,
  destination,
  digestItem,
  eq,
  item,
  itemField,
  itemLog,
  lte,
  source,
  sql,
  type Tx,
} from "@watchdog/db";
import { storableMessage } from "../agent/call-agent.ts";
import { evaluateActionCondition } from "../rules/condition.ts";
import { actionSchema } from "../rules/schema.ts";
import { conditionToWords } from "../rules/words.ts";
import { categoriesOf } from "./extract.ts";

export interface ActDeps {
  /**
   * Queues new Deliveries' jobs on the transaction that inserts them, so a worker dying after the commit
   * can't lose a send, and a rollback leaves no job.
   */
  enqueueDeliveries: (tx: Tx, deliveryIds: string[]) => Promise<void>;
}

/** The enabled Actions an Item can fire, oldest first. The clocks are compared as in `rulesFor`. */
function actionsFor(tx: Tx, itemId: string) {
  return (
    tx
      .select({ id: action.id, name: action.name, definition: action.definition })
      .from(action)
      .innerJoin(
        item,
        and(eq(item.id, itemId), eq(item.workspaceId, action.workspaceId), lte(action.updatedAt, item.capturedAt)),
      )
      .where(eq(action.enabled, true))
      .orderBy(action.createdAt, action.id)
      // The lock keeps an Action from going before its Deliveries' foreign keys are checked.
      .for("key share", { of: action })
  );
}

/** An Action's Destinations, locked until their Deliveries' foreign keys are checked at commit. */
function destinationsOf(tx: Tx, actionId: string) {
  return tx
    .select({ id: destination.id, name: destination.name, type: destination.type, confirmedAt: destination.confirmedAt })
    .from(actionDestination)
    .innerJoin(destination, eq(actionDestination.destinationId, destination.id))
    .where(eq(actionDestination.actionId, actionId))
    .orderBy(destination.name)
    .for("key share");
}

/** What a Condition reads from the Item as it stands now, with this transaction's Rating and fields. */
async function conditionItem(tx: Tx, itemId: string) {
  const [row] = await tx
    .select({ item, sourceType: source.type })
    .from(item)
    .innerJoin(source, eq(item.sourceId, source.id))
    .where(eq(item.id, itemId));
  if (row === undefined) return undefined;
  const fields = await tx
    // Not the column itself: Drizzle parses a jsonb string again on read, which turns the string "2" into
    // the number 2, and a Condition compares types.
    .select({ name: itemField.name, value: sql<unknown>`${itemField.value}` })
    .from(itemField)
    .where(eq(itemField.itemId, itemId));
  return {
    ...row.item,
    sourceType: row.sourceType,
    categories: await categoriesOf(tx, itemId),
    fields: Object.fromEntries(fields.map(({ name, value }) => [name, value])),
  };
}

const namesOf = (rows: { name: string }[]) => rows.map(({ name }) => name);

/** Records the Item's Deliveries and Digest rows, and says in its Log what happened. */
async function runActStage(tx: Tx, itemId: string, deps: ActDeps) {
  const log = async (message: string, data: Record<string, unknown> = {}) => {
    // A Condition can hold long values, and the Log holds a readable sentence.
    await tx.insert(itemLog).values({ itemId, stage: "act", message: storableMessage(message), data });
  };

  const target = await conditionItem(tx, itemId);
  if (target === undefined) return;
  if (target.isBackfill) {
    await log("No Action fired: this Item came from a Backfill");
    return;
  }

  let matched = false;
  const queued: string[] = [];
  for (const saved of await actionsFor(tx, itemId)) {
    const named = { actionId: saved.id, action: saved.name };
    const parsed = actionSchema.safeParse(saved.definition);
    if (!parsed.success) {
      await log(`Skipped Action ${saved.name}: its definition no longer parses`, {
        ...named,
        issues: parsed.error.issues.map((issue) => issue.message),
      });
      continue;
    }
    const { when, kind } = parsed.data;
    if (!evaluateActionCondition(when, target)) continue;
    matched = true;

    // A webhook has no confirmation step, so only its type says this and not `confirmed_at`.
    const all = await destinationsOf(tx, saved.id);
    const isConfirmed = ({ type, confirmedAt }: (typeof all)[number]) => type === "webhook" || confirmedAt !== null;
    const confirmed = all.filter(isConfirmed);
    const skipped = namesOf(all.filter((row) => !isConfirmed(row)));
    const data = { ...named, kind, condition: conditionToWords(when), destinations: namesOf(confirmed), skipped };
    const skippedNote = skipped.length > 0 ? `. Skipped ${skipped.join(", ")}: not confirmed yet` : "";
    if (confirmed.length === 0) {
      await log(`Action ${saved.name} didn't fire: it has no confirmed Destination${skippedNote}`, data);
      continue;
    }

    if (kind === "digest") {
      await tx.insert(digestItem).values({ actionId: saved.id, itemId }).onConflictDoNothing();
    } else {
      const inserted = await tx
        .insert(delivery)
        .values(confirmed.map(({ id }) => ({ actionId: saved.id, itemId, destinationId: id })))
        .onConflictDoNothing()
        .returning({ id: delivery.id });
      queued.push(...inserted.map(({ id }) => id));
    }
    // "Queued", because whether it's sent is the Delivery's own `act` rows to say.
    const verb = kind === "digest" ? "Collected for" : "Queued for";
    await log(
      `Action ${saved.name} fired: ${data.condition}. ${verb} ${data.destinations.join(", ")}${skippedNote}`,
      data,
    );
  }

  if (!matched) await log("No Action matched");
  if (queued.length > 0) await deps.enqueueDeliveries(tx, queued);
}

/**
 * Commits `work`, the Act stage and `processed_at` together, unless the Item is gone or another run
 * already finished it. So an Item can't finish without its Deliveries, and a retry can't fire twice.
 */
export async function finishItem(
  db: Db,
  itemId: string,
  now: () => Date,
  deps: ActDeps,
  work?: (tx: Tx) => Promise<void>,
) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ processedAt: item.processedAt })
      .from(item)
      .where(eq(item.id, itemId))
      .for("update");
    if (row?.processedAt !== null) return;
    await work?.(tx);
    await runActStage(tx, itemId, deps);
    await tx.update(item).set({ processedAt: now() }).where(eq(item.id, itemId));
  });
}
