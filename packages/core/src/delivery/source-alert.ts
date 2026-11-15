// Source failing and Source recovered alerts (docs: Actions and delivery, "Source Health alerts"). One row
// per Source change and recipient, sent through the senders Deliveries use, under the same settings.
import { randomUUID } from "node:crypto";
import { addMinutes, subHours } from "date-fns";
import {
  and,
  type Db,
  destination,
  eq,
  gt,
  healthAlertDestination,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sentMessage,
  source,
  sourceAlert,
  type SQL,
  sql,
  type Tx,
  user,
  workspace,
} from "@watchdog/db";
import { type Destination, failureReason, nextRetry, type Sender } from "./deliver.ts";
import { type EmailCap, emailCapEnd, queueCapNoticeOnce, takeEmailCapTurn } from "./email-cap.ts";
import { scheduleDelivery } from "./schedule-delivery.ts";
import {
  groupedSourceAlertContent,
  sourceAlertContent,
  type SourceAlertMessage,
} from "./source-alert-content.ts";

type Kind = (typeof sourceAlert.$inferSelect)["kind"];

/**
 * Writes one alert per recipient for Sources that just became failing or recovered: the confirmed
 * Destinations the Workspace's Health alerts setting names, or the sign-in address when it names none.
 * The rows are held and due, and the worker's sweep queues their jobs within a minute.
 *
 * One call is one event: every row it writes shares an `event_id`, and the send that takes one of them
 * takes the event's other due rows to that recipient with it, as one message (GitHub issue #323).
 */
export async function queueSourceAlerts(
  tx: Tx,
  changed: { id: string; workspaceId: string }[],
  kind: Kind,
  error: string | null,
) {
  const eventId = randomUUID();
  for (const workspaceId of new Set(changed.map((row) => row.workspaceId))) {
    const named = await tx
      .select({ id: destination.id, type: destination.type, confirmedAt: destination.confirmedAt })
      .from(healthAlertDestination)
      .innerJoin(destination, eq(destination.id, healthAlertDestination.destinationId))
      .where(eq(healthAlertDestination.workspaceId, workspaceId));
    const confirmed = named.filter((row) => row.type !== "webhook" && row.confirmedAt !== null).map(({ id }) => id);
    // The sign-in address too when none of the named ones can receive, so a failing Source is never silent.
    const recipients = confirmed.length === 0 ? [null] : confirmed;
    const rows = changed
      .filter((row) => row.workspaceId === workspaceId)
      .flatMap(({ id }) =>
        recipients.map((destinationId) => ({ workspaceId, sourceId: id, destinationId, eventId, kind, error })),
      );
    if (rows.length > 0) await tx.insert(sourceAlert).values(rows);
  }
}

/**
 * A push Source's Health, which changes with access and not with silence: `lost` says why its Sources
 * can't be read any more and makes them failing, and null is access returned. Only a change between
 * failing and not alerts, so saying it again is quiet.
 */
export async function setPushSourceHealth(tx: Tx, which: SQL | undefined, lost: string | null, at: Date = new Date()) {
  const rows = await tx
    .select({ id: source.id, workspaceId: source.workspaceId, health: source.health })
    .from(source)
    .where(which)
    .orderBy(source.id)
    .for("update");
  if (rows.length === 0) return;
  await tx
    .update(source)
    .set(
      lost === null
        ? { health: "ok", consecutiveFailures: 0, lastSuccessAt: at, lastError: null, lastErrorAt: null }
        : { health: "failing", lastError: lost, lastErrorAt: at },
    )
    .where(
      inArray(
        source.id,
        rows.map(({ id }) => id),
      ),
    );
  const changed = rows.filter(({ health }) => (health === "failing") === (lost === null));
  await queueSourceAlerts(tx, changed, lost === null ? "recovered" : "failing", lost);
}

/**
 * Puts held alerts whose time has come back in the queue, and returns them. A row another transaction
 * holds is passed over, as for a Delivery.
 */
export async function releaseDueSourceAlerts(tx: Tx) {
  const due = tx
    .select({ id: sourceAlert.id })
    .from(sourceAlert)
    .where(and(eq(sourceAlert.status, "held"), lte(sourceAlert.nextAttemptAt, sql`now()`)))
    .for("update", { skipLocked: true });
  return tx
    .update(sourceAlert)
    .set({ status: "queued", nextAttemptAt: null })
    .where(inArray(sourceAlert.id, due))
    .returning({ id: sourceAlert.id });
}

export interface SourceAlertDeps {
  senders: { telegram: Sender<SourceAlertMessage>; email: Sender<SourceAlertMessage> };
  /** Where Watchdog is served, for the link to the Sources screen. */
  appUrl: string;
  /** Queues the next attempt's job on the transaction that records this one, as for a Delivery. */
  retrySourceAlert: (tx: Tx, alertId: string, at: Date) => Promise<void>;
  /** The hosted daily cap on alert mail. Self-hosted has none. */
  emailCap?: EmailCap;
  now?: () => Date;
}

/**
 * Sends a queued Health alert, along with the Health change's other due rows to the same recipient, as
 * one message, unless the settings hold them back, and records how it went with its retry. One message
 * and one `sent_message` row, so a session that fails thirty chats counts once against the recipient's
 * rate limit and the hosted email cap, not thirty times (GitHub issue #323). It only throws when it
 * can't record, and then pg-boss runs the job again.
 *
 * To a Destination, it takes the Destination's row first and holds it through the send, as a Delivery's
 * job does (ADR 0028), so the two take turns and each counts the other's message against the rate limit
 * and the burst window. It always goes as its own message, so the burst window, which only decides what
 * joins a Grouped alert, doesn't hold it. A Source's alerts to one recipient go in the order they were
 * written, so a recovery never arrives before the failure it ends.
 */
export async function sendSourceAlert(db: Db, alertId: string, deps: SourceAlertDeps): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const [found] = await db
    .select({
      destinationId: sourceAlert.destinationId,
      workspaceId: sourceAlert.workspaceId,
      eventId: sourceAlert.eventId,
    })
    .from(sourceAlert)
    .where(eq(sourceAlert.id, alertId));
  if (found === undefined) return;
  const { destinationId, workspaceId, eventId } = found;
  // The sign-in address is a recipient too, and its rows have no Destination.
  const toRecipient =
    destinationId === null ? isNull(sourceAlert.destinationId) : eq(sourceAlert.destinationId, destinationId);

  await db.transaction(async (tx) => {
    const [named] =
      destinationId === null
        ? []
        : await tx.select().from(destination).where(eq(destination.id, destinationId)).for("no key update");
    if (destinationId !== null && named === undefined) return;

    // Before the settings are read, as a Delivery does, so two mails held by the cap queue one notice.
    if (deps.emailCap !== undefined && named?.type !== "telegram") await takeEmailCapTurn(tx, workspaceId);

    // The change's rows for this recipient that are due go together, as a Delivery's job takes the
    // Destination's other due Deliveries. Queued and due by the database's clock, as a Delivery is, so
    // a job that runs again after its attempt committed finds the retry not yet due and ends.
    const rows = await tx
      .select({ alert: sourceAlert, sourceName: source.name, settings: workspace, email: user.email })
      .from(sourceAlert)
      .innerJoin(source, eq(source.id, sourceAlert.sourceId))
      .innerJoin(workspace, eq(workspace.id, sourceAlert.workspaceId))
      .innerJoin(user, eq(user.id, workspace.ownerUserId))
      .where(
        and(
          eq(sourceAlert.eventId, eventId),
          eq(sourceAlert.workspaceId, workspaceId),
          toRecipient,
          eq(sourceAlert.status, "queued"),
          or(isNull(sourceAlert.nextAttemptAt), lte(sourceAlert.nextAttemptAt, sql`now()`)),
        ),
      )
      .orderBy(sourceAlert.createdAt, sourceAlert.id)
      .for("update", { of: sourceAlert });
    const [first] = rows;
    if (first === undefined || !rows.some(({ alert }) => alert.id === alertId)) return;
    const { settings } = first;
    const record = (id: string, outcome: Partial<typeof sourceAlert.$inferInsert>) =>
      tx.update(sourceAlert).set(outcome).where(eq(sourceAlert.id, id));

    // A row whose Source has an alert still waiting from before this change is held back, so a recovery
    // never arrives before the failure it ends. The rest of the change goes now.
    const at = now();
    const later = addMinutes(at, 1);
    const blocked = new Set(
      (
        await tx
          .select({ sourceId: sourceAlert.sourceId })
          .from(sourceAlert)
          .where(
            and(
              inArray(
                sourceAlert.sourceId,
                rows.map(({ alert }) => alert.sourceId),
              ),
              toRecipient,
              inArray(sourceAlert.status, ["queued", "held"]),
              // Before this change's first row, which is the earliest they can be.
              sql`(${sourceAlert.createdAt}, ${sourceAlert.id}) < (${first.alert.createdAt}, ${first.alert.id})`,
            ),
          )
      ).map(({ sourceId }) => sourceId),
    );
    for (const { alert } of rows) {
      if (blocked.has(alert.sourceId)) {
        await record(alert.id, { status: "held", nextAttemptAt: later, retryFrom: later });
      }
    }
    const ready = rows.filter(({ alert }) => !blocked.has(alert.sourceId));
    const [head] = ready;
    if (head === undefined) return;
    const hold = async (until: Date) => {
      for (const { alert } of ready) await record(alert.id, { status: "held", nextAttemptAt: until, retryFrom: until });
    };

    // The sign-in address isn't a Destination, so it has no rate limit or burst window to count against.
    // The email sender reads an address and a confirmation from a Destination, and a sign-in address is
    // confirmed by signing in.
    const target: Destination = named ?? {
      id: settings.id,
      workspaceId: settings.id,
      type: "email",
      name: head.email,
      config: { address: head.email },
      secretCiphertext: null,
      secretShownAt: null,
      confirmedAt: head.alert.createdAt,
      lastError: null,
      lastErrorAt: null,
      createdAt: head.alert.createdAt,
      updatedAt: head.alert.createdAt,
    };
    if (target.type === "webhook") {
      for (const { alert } of ready) {
        await record(alert.id, {
          status: "failed",
          nextAttemptAt: null,
          lastError: "a webhook can't take a Health alert",
        });
      }
      return;
    }
    const setError = async (lastError: string | null, lastErrorAt: Date | null) => {
      if (named === undefined) return;
      await tx
        .update(destination)
        .set({ lastError, lastErrorAt })
        .where(and(eq(destination.id, target.id), lastError === null ? isNotNull(destination.lastError) : undefined));
    };

    const sends =
      named === undefined
        ? []
        : await tx
            .select({ at: sentMessage.sentAt })
            .from(sentMessage)
            .where(
              and(
                eq(sentMessage.destinationId, target.id),
                gt(sentMessage.sentAt, subHours(at, 1)),
              ),
            )
            .orderBy(sentMessage.sentAt);
    // No Severity, so the Severity 5 bypass never applies.
    const decision = scheduleDelivery({ settings, now: at, severity: null, recentSends: sends.map((sent) => sent.at) });
    if (decision.kind === "hold") {
      await hold(decision.until);
      return;
    }
    if (target.type === "email" && deps.emailCap !== undefined) {
      const capEnd = await emailCapEnd(tx, settings, at);
      if (capEnd !== undefined) {
        await hold(capEnd);
        await queueCapNoticeOnce(tx, settings, capEnd, deps.emailCap);
        return;
      }
    }

    // One Source that changed on its own reads as it always has; a change that took several names them.
    const message =
      ready.length === 1
        ? sourceAlertContent(head.alert.kind, head.sourceName, head.alert.error, deps.appUrl)
        : groupedSourceAlertContent(
            head.alert.kind,
            ready.map(({ sourceName }) => sourceName),
            head.alert.error,
            deps.appUrl,
          );
    try {
      await deps.senders[target.type].send(target, message, async (secretCiphertext) => {
        await tx.update(destination).set({ secretCiphertext }).where(eq(destination.id, target.id));
      });
    } catch (error) {
      const failed = now();
      const lastError = failureReason(error);
      const outcomes = ready.map(({ alert }) => {
        const attempts = alert.attempts + 1;
        return { alert, attempts, retryAt: nextRetry(error, attempts, alert.retryFrom ?? alert.createdAt, failed) };
      });
      for (const { alert, attempts, retryAt } of outcomes) {
        await record(
          alert.id,
          retryAt === undefined
            ? { attempts, status: "failed", nextAttemptAt: null, lastError }
            : { attempts, nextAttemptAt: retryAt, lastError },
        );
        if (retryAt !== undefined) await deps.retrySourceAlert(tx, alert.id, retryAt);
      }
      if (outcomes.every(({ retryAt }) => retryAt === undefined)) await setError(lastError, failed);
      return;
    }

    const sentAt = now();
    for (const { alert } of ready) {
      await record(alert.id, { attempts: alert.attempts + 1, status: "sent", sentAt, nextAttemptAt: null, lastError: null });
    }
    // One message, whatever the change took, so it counts once against the Destination's rate limit and
    // the hosted email cap (ADR 0030).
    await tx
      .insert(sentMessage)
      .values({ workspaceId: settings.id, destinationId: named?.id ?? null, type: target.type, sentAt });
    await setError(null, null);
  });
}
