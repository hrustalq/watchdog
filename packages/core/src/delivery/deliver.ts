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
  inArray,
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
import { categoriesOf, fieldsOf } from "../pipeline/extract.ts";
import { alertContent, type AlertMessage, type WebhookMessage } from "./content.ts";
import { capReason, type EmailCap, emailCapEnd, queueCapNoticeOnce, takeEmailCapTurn } from "./email-cap.ts";
import { type GroupedAlert, groupedAlert } from "./group.ts";
import { localTime, scheduleDelivery } from "./schedule-delivery.ts";

export type Destination = typeof destination.$inferSelect;

export interface Sender<Message = AlertMessage | GroupedAlert> {
  /**
   * Rejects when the message didn't go, with a reason the user can read in the Log. Any error is retried
   * with the backoff, unless it's a FinalSendError or a RetryAfterSendError.
   */
  send: (destination: Destination, message: Message) => Promise<void>;
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

/**
 * What a failed request's error should say in the Log. undici's own message is only "fetch failed", and a
 * connection tried on several addresses has a cause with no message. Other errors, such as the egress
 * guard's, say what happened already.
 */
export function unreachable(error: unknown, who: string) {
  if (!(error instanceof TypeError && error.cause instanceof Error)) return error;
  const why = error.cause.message === "" ? "" : `: ${error.cause.message}`;
  return new Error(`${who} can't be reached${why}`);
}

export interface DeliverDeps {
  senders: { telegram: Sender; email: Sender; webhook: Sender<WebhookMessage> };
  /** Where Watchdog is served, for the link to the Item. */
  appUrl: string;
  /**
   * Queues the next attempt's job on the transaction that records this one, so a worker dying after the
   * commit can't lose it. Choosing the time here, not through pg-boss's backoff and its jitter, is what
   * lets the Log say when the retry is and the last one land on the 24 hour mark.
   */
  retryDelivery: (tx: Tx, deliveryId: string, at: Date) => Promise<void>;
  /** The hosted daily cap on alert mail. Self-hosted has none. */
  emailCap?: EmailCap;
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
async function loadDue(reader: Db | Tx, which: SQL) {
  return reader
    .select({
      id: delivery.id,
      createdAt: delivery.createdAt,
      attempts: delivery.attempts,
      retryFrom: delivery.retryFrom,
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

/**
 * Puts held and grouped Deliveries whose time has come back in the queue, and returns them. A row another
 * transaction holds is passed over, because that one is releasing it, and the next sweep finds any that
 * wasn't. So a slow send to one Destination can't hold up another's, and two callers can't deadlock.
 */
export async function releaseDueDeliveries(tx: Tx, which?: SQL) {
  const due = tx
    .select({ id: delivery.id })
    .from(delivery)
    .where(and(which, inArray(delivery.status, ["held", "grouped"]), lte(delivery.nextAttemptAt, sql`now()`)))
    .for("update", { skipLocked: true });
  return tx
    .update(delivery)
    .set({ status: "queued", nextAttemptAt: null })
    .where(inArray(delivery.id, due))
    .returning({ id: delivery.id });
}

/** The Condition as it reads now. The Log's row from when the Action fired keeps how it read then. */
function whyItFired({ name, definition }: { name: string; definition: unknown }) {
  const parsed = actionSchema.safeParse(definition);
  return parsed.success ? conditionToWords(parsed.data.when) : `Action ${name} fired`;
}

function alertMessage(rows: DueDelivery[], appUrl: string) {
  const [first] = rows;
  return first !== undefined && rows.length === 1
    ? alertContent(first.item, first.sourceName, whyItFired(first.action), appUrl)
    : groupedAlert(rows.map((row) => row.item), appUrl);
}

/** A webhook's body, as the Item stands now. Undefined when the Item has gone since `loadDue`. */
async function webhookMessage(db: Db, row: DueDelivery): Promise<WebhookMessage | undefined> {
  const [envelope] = await db
    .select({
      id: item.id,
      sourceId: item.sourceId,
      externalId: item.externalId,
      url: item.url,
      title: item.title,
      author: item.author,
      body: item.body,
      publishedAt: item.publishedAt,
      capturedAt: item.capturedAt,
      language: item.language,
      isBackfill: item.isBackfill,
      summary: item.summary,
    })
    .from(item)
    .where(eq(item.id, row.item.id));
  if (envelope === undefined) return undefined;
  const { severity, importance } = row.item;
  return {
    action: row.action.name,
    item: envelope,
    rating: severity === null || importance === null ? null : { severity, importance },
    categories: await categoriesOf(db, row.item.id),
    fields: await fieldsOf(db, row.item.id),
    firedBecause: whyItFired(row.action),
  };
}

/** Records an outcome, unless the Delivery was deleted during the send or another job recorded first. */
async function record(
  tx: Tx,
  row: DueDelivery,
  target: Destination,
  outcome: Partial<typeof delivery.$inferInsert>,
  log: { message: string; data?: Record<string, unknown> },
  alsoRecord?: (tx: Tx) => Promise<void>,
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
  await alsoRecord?.(tx);
}

/** Holds or groups the alerts that can't go now, and returns the ones that can. */
async function applySchedule(
  tx: Tx,
  due: DueDelivery[],
  target: Destination,
  now: Date,
  cap: EmailCap | undefined,
) {
  const emailCap = target.type === "email" ? cap : undefined;
  if (emailCap !== undefined) await takeEmailCapTurn(tx, target.workspaceId);
  const [settings] = await tx.select().from(workspace).where(eq(workspace.id, target.workspaceId));
  if (settings === undefined) return [];

  const hold = (row: DueDelivery, until: Date, reason: string, groupId: string | null) =>
    record(
      tx,
      row,
      target,
      { status: groupId === null ? "held" : "grouped", nextAttemptAt: until, retryFrom: until, groupId },
      {
        message: `Held until ${localTime(until, settings.timezone)}: ${reason}`,
        data: { heldUntil: until.toISOString() },
      },
    );

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
    if (decision.kind === "hold") {
      await hold(row, decision.until, decision.reason, null);
      continue;
    }
    if (groupId === undefined) {
      const [open] = await tx
        .select({ groupId: delivery.groupId })
        .from(delivery)
        .where(and(eq(delivery.destinationId, target.id), eq(delivery.status, "grouped")))
        .limit(1);
      groupId = open?.groupId ?? crypto.randomUUID();
    }
    await hold(row, decision.until, "burst window", groupId);
  }

  // Last, because a mail another setting holds back isn't one of the day's 50 yet.
  if (emailCap === undefined || sending.length === 0) return sending;
  const capEnd = await emailCapEnd(tx, settings, now);
  if (capEnd === undefined) return sending;
  for (const row of sending) await hold(row, capEnd, capReason, null);
  await queueCapNoticeOnce(tx, settings, capEnd, emailCap);
  return [];
}

/**
 * Sends the Deliveries as one message through `transmit` and records how it went on each. `recording` runs
 * each outcome in the transaction that's holding the Destination, or in one of its own when nothing is.
 */
async function send(
  rows: DueDelivery[],
  target: Destination,
  deps: DeliverDeps,
  now: () => Date,
  recording: (write: (tx: Tx) => Promise<void>) => Promise<void>,
  transmit: () => Promise<void>,
) {
  if (rows.length === 0) return;

  try {
    await transmit();
  } catch (error) {
    const failed = now();
    const reason = storableMessage(error instanceof Error ? error.message : String(error)).slice(0, reasonLength);
    const failure = `Sending to ${target.name} failed: ${reason}`;
    const final = error instanceof FinalSendError;

    for (const row of rows) {
      const attempts = row.attempts + 1;
      const windowEnd = (row.retryFrom ?? row.createdAt).getTime() + retryWindowMs;
      if (final || failed.getTime() >= windowEnd) {
        await recording((tx) =>
          record(
            tx,
            row,
            target,
            { attempts, status: "failed", nextAttemptAt: null, lastError: reason },
            {
              message: `${failure}. ${final ? "It won't be retried" : "No more retries after 24 hours"}`,
              data: { attempt: attempts, final: true },
            },
            async (inTx) => {
              await inTx
                .update(destination)
                .set({ lastError: reason, lastErrorAt: failed })
                .where(eq(destination.id, target.id));
            },
          ),
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
      await recording((tx) =>
        record(
          tx,
          row,
          target,
          { attempts, nextAttemptAt: retryAt, lastError: reason },
          {
            message: `${failure}, retrying at ${retryAt.toISOString()}`,
            data: { attempt: attempts, retryAt: retryAt.toISOString() },
          },
          (inTx) => deps.retryDelivery(inTx, row.id, retryAt),
        ),
      );
    }
    return;
  }

  const sentAt = now();
  // New for each message, even after waiting under an id, because a group's rows can go out in two sends.
  const groupId = rows.length === 1 ? null : crypto.randomUUID();
  const sentTo = `Sent to ${target.name}${rows.length === 1 ? "" : ` in a group of ${String(rows.length)}`}`;
  for (const row of rows) {
    const attempts = row.attempts + 1;
    await recording((tx) =>
      record(
        tx,
        row,
        target,
        { attempts, status: "sent", sentAt, nextAttemptAt: null, lastError: null, groupId },
        { message: sentTo, data: { attempt: attempts } },
      ),
    );
  }
  if (target.lastError !== null) {
    await recording(async (tx) => {
      await tx.update(destination).set({ lastError: null, lastErrorAt: null }).where(eq(destination.id, target.id));
    });
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
 * webhook gets one request per Item with no settings to check, so it takes no lock and holds no
 * connection through its request.
 */
export async function deliver(db: Db, deliveryId: string, deps: DeliverDeps): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const [found] = await db
    .select({ destination })
    .from(delivery)
    .innerJoin(destination, eq(delivery.destinationId, destination.id))
    .where(eq(delivery.id, deliveryId));
  if (found === undefined) return;
  if (found.destination.type === "webhook") {
    const due = await loadDue(db, eq(delivery.id, deliveryId));
    const [row] = due;
    const message = row && (await webhookMessage(db, row));
    if (message === undefined) return;
    await send(
      due,
      found.destination,
      deps,
      now,
      (write) => db.transaction(write),
      () => deps.senders.webhook.send(found.destination, message),
    );
    return;
  }

  const sender = deps.senders[found.destination.type];
  await db.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(destination)
      .where(eq(destination.id, found.destination.id))
      .for("no key update");
    if (target === undefined) return;

    // Held alerts whose time has come join this send rather than wait for the sweep. If they waited, a
    // new alert would go alone and restart the burst window, and a steady stream could hold them forever.
    await releaseDueDeliveries(tx, eq(delivery.destinationId, target.id));
    const due = await loadDue(tx, eq(delivery.destinationId, target.id));
    if (due.length === 0) return;
    const sending = await applySchedule(tx, due, target, now(), deps.emailCap);
    await send(
      sending,
      target,
      deps,
      now,
      (write) => write(tx),
      () => sender.send(target, alertMessage(sending, deps.appUrl)),
    );
  });
}
