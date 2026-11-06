// Sends one Delivery and records how it went (docs: Actions and delivery, "Deliveries"; ADR 0028). The
// worker's deliver queue calls this once per job.
import {
  action,
  and,
  type Db,
  delivery,
  destination,
  eq,
  isNull,
  item,
  itemLog,
  lte,
  or,
  source,
  sql,
  type Tx,
} from "@watchdog/db";
import { storableMessage } from "../agent/call-agent.ts";
import { actionSchema } from "../rules/schema.ts";
import { conditionToWords } from "../rules/words.ts";
import { alertContent, type AlertMessage } from "./content.ts";

export type Destination = typeof destination.$inferSelect;

export interface Sender {
  /** Rejects when the message didn't go, with a reason the user can read in the Log. */
  send: (destination: Destination, message: AlertMessage) => Promise<void>;
}

export interface DeliverDeps {
  senders: Record<Destination["type"], Sender>;
  /** Where Watchdog is served, for the link to the Item. */
  appUrl: string;
  /**
   * Queues the next attempt's job on the transaction that records this one, so a worker dying after the
   * commit can't lose it. Choosing the time here, not through pg-boss's backoff and its jitter, is what
   * lets the Log say when the retry is and the last one land on the 24 hour mark.
   */
  retryDelivery: (tx: Tx, deliveryId: string, at: Date) => Promise<void>;
  now?: () => Date;
}

const firstRetryDelayMs = 30_000;
const retryWindowMs = 24 * 60 * 60 * 1000;
/** Short enough that the Log's sentence keeps what follows the reason. */
const reasonLength = 500;

/**
 * A Delivery that a job should send now. Anything else is held, grouped, finished or gone, or waiting
 * for a retry whose job committed with that time, so this job is an old one that ran again. The
 * database's clock decides, as it does when pg-boss starts a job, so clock skew can't strand a retry.
 */
async function loadDue(db: Db, deliveryId: string) {
  const [row] = await db
    .select({
      createdAt: delivery.createdAt,
      attempts: delivery.attempts,
      item: {
        id: item.id,
        title: item.title,
        summary: item.summary,
        severity: item.severity,
        importance: item.importance,
      },
      sourceName: source.name,
      action: { id: action.id, name: action.name, definition: action.definition },
      destination,
    })
    .from(delivery)
    .innerJoin(item, eq(delivery.itemId, item.id))
    .innerJoin(source, eq(item.sourceId, source.id))
    .innerJoin(action, eq(delivery.actionId, action.id))
    .innerJoin(destination, eq(delivery.destinationId, destination.id))
    .where(
      and(
        eq(delivery.id, deliveryId),
        eq(delivery.status, "queued"),
        or(isNull(delivery.nextAttemptAt), lte(delivery.nextAttemptAt, sql`now()`)),
      ),
    );
  return row;
}

/** The Condition as it reads now. The Log's row from when the Action fired keeps how it read then. */
function whyItFired({ name, definition }: { name: string; definition: unknown }) {
  const parsed = actionSchema.safeParse(definition);
  return parsed.success ? conditionToWords(parsed.data.when) : `Action ${name} fired`;
}

/**
 * Sends a queued Delivery. A failed send is an outcome, recorded here with its retry, so this only
 * throws when it can't record, and then pg-boss runs the job again. A send can repeat if a worker dies
 * between the send and the commit, which nothing can rule out across a network call.
 */
export async function deliver(db: Db, deliveryId: string, deps: DeliverDeps): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const row = await loadDue(db, deliveryId);
  if (row === undefined) return;
  const { destination: target } = row;
  const attempts = row.attempts + 1;
  const data = { actionId: row.action.id, destinationId: target.id, destination: target.name, attempt: attempts };

  /** Commits the outcome, unless the Delivery was deleted during the send or another job recorded first. */
  const record = async (
    outcome: Partial<typeof delivery.$inferInsert>,
    log: { message: string; data?: Record<string, unknown> },
    alsoRecord?: (tx: Tx) => Promise<void>,
  ) => {
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(delivery)
        .set({ attempts, ...outcome })
        .where(and(eq(delivery.id, deliveryId), eq(delivery.status, "queued"), eq(delivery.attempts, row.attempts)))
        .returning({ id: delivery.id });
      if (updated.length === 0) return;
      await tx.insert(itemLog).values({
        itemId: row.item.id,
        stage: "act",
        message: storableMessage(log.message),
        data: { ...data, ...log.data },
      });
      await alsoRecord?.(tx);
    });
  };

  const message = alertContent(row.item, row.sourceName, whyItFired(row.action), deps.appUrl);
  try {
    await deps.senders[target.type].send(target, message);
  } catch (error) {
    const failed = now();
    const reason = storableMessage(error instanceof Error ? error.message : String(error)).slice(0, reasonLength);
    const failure = `Sending to ${target.name} failed: ${reason}`;
    const windowEnd = row.createdAt.getTime() + retryWindowMs;

    if (failed.getTime() >= windowEnd) {
      await record(
        { status: "failed", nextAttemptAt: null, lastError: reason },
        { message: `${failure}. No more retries after 24 hours`, data: { final: true } },
        async (tx) => {
          await tx
            .update(destination)
            .set({ lastError: reason, lastErrorAt: failed })
            .where(eq(destination.id, target.id));
        },
      );
      return;
    }

    const backoff = firstRetryDelayMs * 2 ** (attempts - 1);
    const retryAt = new Date(Math.min(failed.getTime() + backoff, windowEnd));
    await record(
      { nextAttemptAt: retryAt, lastError: reason },
      { message: `${failure}, retrying at ${retryAt.toISOString()}`, data: { retryAt: retryAt.toISOString() } },
      (tx) => deps.retryDelivery(tx, deliveryId, retryAt),
    );
    return;
  }

  await record(
    { status: "sent", sentAt: now(), nextAttemptAt: null, lastError: null },
    { message: `Sent to ${target.name}` },
    async (tx) => {
      if (target.lastError === null) return;
      await tx.update(destination).set({ lastError: null, lastErrorAt: null }).where(eq(destination.id, target.id));
    },
  );
}
