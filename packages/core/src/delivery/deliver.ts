// Sends one Delivery and records how it went (docs: Actions and delivery, "Deliveries"; ADR 0028). The
// worker's deliver queue calls this once per job.
import {
  action,
  and,
  type Db,
  delivery,
  destination,
  eq,
  gt,
  isNull,
  item,
  itemLog,
  lte,
  or,
  source,
  type SQL,
  sql,
  type Tx,
  workspace,
} from "@watchdog/db";
import { storableMessage } from "../agent/call-agent.ts";
import { actionSchema } from "../rules/schema.ts";
import { conditionToWords } from "../rules/words.ts";
import { alertContent, type AlertMessage } from "./content.ts";
import { type GroupedAlert, groupedAlert } from "./group.ts";
import { localTime, scheduleDelivery } from "./schedule-delivery.ts";

export type Destination = typeof destination.$inferSelect;

export interface Sender {
  /**
   * Rejects when the message didn't go, with a reason the user can read in the Log. Any error is retried
   * with the backoff, unless it's a FinalSendError or a RetryAfterSendError.
   */
  send: (destination: Destination, message: AlertMessage | GroupedAlert) => Promise<void>;
}

/** A refusal no later attempt can get past, so the Delivery fails at once. */
export class FinalSendError extends Error {
  override name = "FinalSendError";
}

/** The receiver said how long to wait, which replaces the backoff for the next attempt. */
export class RetryAfterSendError extends Error {
  override name = "RetryAfterSendError";
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
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

const hourMs = 60 * 60 * 1000;
const firstRetryDelayMs = 30_000;
const retryWindowMs = 24 * hourMs;
/** Short enough that the Log's sentence keeps what follows the reason. */
const reasonLength = 500;

/**
 * The Deliveries a job should send now, as Top would list them, with unrated Items last. Anything else
 * is held, grouped, finished or gone, or waiting for a retry whose job committed with that time. The
 * database's clock decides, as it does when pg-boss starts a job, so clock skew can't strand a retry.
 */
async function loadDue(tx: Tx, which: SQL) {
  return tx
    .select({
      id: delivery.id,
      createdAt: delivery.createdAt,
      attempts: delivery.attempts,
      groupId: delivery.groupId,
      item: {
        id: item.id,
        title: item.title,
        summary: item.summary,
        severity: item.severity,
        importance: item.importance,
      },
      sourceName: source.name,
      action: { id: action.id, name: action.name, definition: action.definition },
    })
    .from(delivery)
    .innerJoin(item, eq(delivery.itemId, item.id))
    .innerJoin(source, eq(item.sourceId, source.id))
    .innerJoin(action, eq(delivery.actionId, action.id))
    .where(
      and(
        which,
        eq(delivery.status, "queued"),
        or(isNull(delivery.nextAttemptAt), lte(delivery.nextAttemptAt, sql`now()`)),
      ),
    )
    .orderBy(sql`${item.topScore} desc nulls last`, sql`${item.capturedAt} desc`, sql`${item.id} desc`);
}

type DueDelivery = Awaited<ReturnType<typeof loadDue>>[number];

/** The Condition as it reads now. The Log's row from when the Action fired keeps how it read then. */
function whyItFired({ name, definition }: { name: string; definition: unknown }) {
  const parsed = actionSchema.safeParse(definition);
  return parsed.success ? conditionToWords(parsed.data.when) : `Action ${name} fired`;
}

/** Records an outcome, unless the Delivery was deleted during the send or another job recorded first. */
async function record(
  tx: Tx,
  row: DueDelivery,
  target: Destination,
  outcome: Partial<typeof delivery.$inferInsert>,
  log: { message: string; data?: Record<string, unknown> },
  alsoRecord?: () => Promise<void>,
) {
  const updated = await tx
    .update(delivery)
    .set(outcome)
    .where(and(eq(delivery.id, row.id), eq(delivery.status, "queued"), eq(delivery.attempts, row.attempts)))
    .returning({ id: delivery.id });
  if (updated.length === 0) return;
  await tx.insert(itemLog).values({
    itemId: row.item.id,
    stage: "act",
    message: storableMessage(log.message),
    data: { actionId: row.action.id, destinationId: target.id, destination: target.name, ...log.data },
  });
  await alsoRecord?.();
}

/** Holds or groups the alerts that can't go now, and returns the ones that can. */
async function applySchedule(tx: Tx, due: DueDelivery[], target: Destination, now: Date) {
  const [settings] = await tx
    .select({
      timezone: workspace.timezone,
      quietHoursStart: workspace.quietHoursStart,
      quietHoursEnd: workspace.quietHoursEnd,
      severity5BypassesQuietHours: workspace.severity5BypassesQuietHours,
      alertsPerHour: workspace.alertsPerHour,
      burstWindowSeconds: workspace.burstWindowSeconds,
    })
    .from(workspace)
    .where(eq(workspace.id, target.workspaceId));
  if (settings === undefined) return [];

  // One time for each message, because the rows of a Grouped alert count as one.
  const sends = await tx
    .select({ at: sql<Date>`max(${delivery.sentAt})`.mapWith(delivery.sentAt) })
    .from(delivery)
    .where(
      and(
        eq(delivery.destinationId, target.id),
        eq(delivery.status, "sent"),
        gt(delivery.sentAt, new Date(now.getTime() - hourMs)),
      ),
    )
    .groupBy(sql`coalesce(${delivery.groupId}, ${delivery.id})`)
    .orderBy(sql`max(${delivery.sentAt})`);
  const recentSends = sends.map(({ at }) => at);

  let groupId: string | undefined;
  const sending: DueDelivery[] = [];
  for (const row of due) {
    const decision = scheduleDelivery({ settings, now, severity: row.item.severity, recentSends });
    if (decision.kind === "send") {
      sending.push(row);
      continue;
    }
    const grouped = decision.kind === "group";
    if (grouped && groupId === undefined) {
      const [open] = await tx
        .select({ groupId: delivery.groupId })
        .from(delivery)
        .where(and(eq(delivery.destinationId, target.id), eq(delivery.status, "grouped")))
        .limit(1);
      groupId = open?.groupId ?? crypto.randomUUID();
    }
    await record(
      tx,
      row,
      target,
      { status: grouped ? "grouped" : "held", nextAttemptAt: decision.until, groupId: grouped ? groupId : null },
      {
        message: `Held until ${localTime(decision.until, settings.timezone)}: ${grouped ? "burst window" : decision.reason}`,
        data: { heldUntil: decision.until.toISOString() },
      },
    );
  }
  return sending;
}

/** Sends the Deliveries as one message and records how it went on each. */
async function send(tx: Tx, rows: DueDelivery[], target: Destination, deps: DeliverDeps, now: () => Date) {
  const [first] = rows;
  if (first === undefined) return;
  const message =
    rows.length === 1
      ? alertContent(first.item, first.sourceName, whyItFired(first.action), deps.appUrl)
      : groupedAlert(rows.map((row) => row.item), deps.appUrl);

  try {
    await deps.senders[target.type].send(target, message);
  } catch (error) {
    const failed = now();
    const reason = storableMessage(error instanceof Error ? error.message : String(error)).slice(0, reasonLength);
    const failure = `Sending to ${target.name} failed: ${reason}`;
    const final = error instanceof FinalSendError;

    for (const row of rows) {
      const attempts = row.attempts + 1;
      const windowEnd = row.createdAt.getTime() + retryWindowMs;
      if (final || failed.getTime() >= windowEnd) {
        await record(
          tx,
          row,
          target,
          { attempts, status: "failed", nextAttemptAt: null, lastError: reason },
          {
            message: `${failure}. ${final ? "It won't be retried" : "No more retries after 24 hours"}`,
            data: { attempt: attempts, final: true },
          },
          async () => {
            await tx
              .update(destination)
              .set({ lastError: reason, lastErrorAt: failed })
              .where(eq(destination.id, target.id));
          },
        );
        continue;
      }

      // A told wait can pass the 24 hour mark, because an attempt sooner than that would only be refused.
      const backoff = firstRetryDelayMs * 2 ** (attempts - 1);
      const retryAt = new Date(
        error instanceof RetryAfterSendError
          ? failed.getTime() + error.retryAfterMs
          : Math.min(failed.getTime() + backoff, windowEnd),
      );
      await record(
        tx,
        row,
        target,
        { attempts, nextAttemptAt: retryAt, lastError: reason },
        {
          message: `${failure}, retrying at ${retryAt.toISOString()}`,
          data: { attempt: attempts, retryAt: retryAt.toISOString() },
        },
        () => deps.retryDelivery(tx, row.id, retryAt),
      );
    }
    return;
  }

  const sentAt = now();
  const groupId = rows.length === 1 ? null : (rows.find((row) => row.groupId !== null)?.groupId ?? crypto.randomUUID());
  const sentTo = `Sent to ${target.name}${rows.length === 1 ? "" : ` in a group of ${String(rows.length)}`}`;
  for (const row of rows) {
    const attempts = row.attempts + 1;
    await record(
      tx,
      row,
      target,
      { attempts, status: "sent", sentAt, nextAttemptAt: null, lastError: null, groupId },
      { message: sentTo, data: { attempt: attempts } },
    );
  }
  if (target.lastError !== null) {
    await tx.update(destination).set({ lastError: null, lastErrorAt: null }).where(eq(destination.id, target.id));
  }
}

/**
 * Sends a queued Delivery, along with whatever else is due to its Destination, unless the settings hold
 * it back. A failed send is an outcome, recorded here with its retry, so this only throws when it can't
 * record, and then pg-boss runs the job again. A send can repeat if a worker dies between the send and
 * the commit, which nothing can rule out across a network call.
 *
 * Jobs for one Destination take turns on its row, held through the send, so two can't both send an Item
 * (ADR 0028). Finding its rows sent, a waiting job ends at once, so a burst holds the queue only for one
 * send. The lock lets a new Delivery in, because it doesn't touch the key its foreign key reads. A
 * webhook gets one request per Item with no settings to check, so its sends don't wait for each other.
 */
export async function deliver(db: Db, deliveryId: string, deps: DeliverDeps): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const [found] = await db
    .select({ destinationId: delivery.destinationId, type: destination.type })
    .from(delivery)
    .innerJoin(destination, eq(delivery.destinationId, destination.id))
    .where(eq(delivery.id, deliveryId));
  if (found === undefined) return;
  const isWebhook = found.type === "webhook";

  await db.transaction(async (tx) => {
    const reading = tx.select().from(destination).where(eq(destination.id, found.destinationId));
    const [target] = await (isWebhook ? reading : reading.for("no key update"));
    if (target === undefined) return;

    const due = await loadDue(tx, isWebhook ? eq(delivery.id, deliveryId) : eq(delivery.destinationId, target.id));
    if (!due.some((row) => row.id === deliveryId)) return;
    await send(tx, isWebhook ? due : await applySchedule(tx, due, target, now()), target, deps, now);
  });
}
