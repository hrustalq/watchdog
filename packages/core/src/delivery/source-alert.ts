// Source failing and Source recovered alerts (docs: Actions and delivery, "Source Health alerts"). One row
// per Source change and recipient, sent through the senders Deliveries use, under the same settings.
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
import { sourceAlertContent, type SourceAlertMessage } from "./source-alert-content.ts";

type Kind = (typeof sourceAlert.$inferSelect)["kind"];

/**
 * Writes one alert per recipient for Sources that just became failing or recovered: the confirmed
 * Destinations the Workspace's Health alerts setting names, or the sign-in address when it names none.
 * The rows are held and due, and the worker's sweep queues their jobs within a minute.
 */
export async function queueSourceAlerts(
  tx: Tx,
  changed: { id: string; workspaceId: string }[],
  kind: Kind,
  error: string | null,
) {
  for (const workspaceId of new Set(changed.map((row) => row.workspaceId))) {
    const named = await tx
      .select({ id: destination.id, type: destination.type, confirmedAt: destination.confirmedAt })
      .from(healthAlertDestination)
      .innerJoin(destination, eq(destination.id, healthAlertDestination.destinationId))
      .where(eq(healthAlertDestination.workspaceId, workspaceId));
    const recipients =
      named.length === 0
        ? [null]
        : named.filter((row) => row.type !== "webhook" && row.confirmedAt !== null).map(({ id }) => id);
    const rows = changed
      .filter((row) => row.workspaceId === workspaceId)
      .flatMap(({ id }) => recipients.map((destinationId) => ({ workspaceId, sourceId: id, destinationId, kind, error })));
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
 * Sends a queued Health alert, unless the settings hold it back, and records how it went with its retry.
 * It only throws when it can't record, and then pg-boss runs the job again.
 *
 * To a Destination, it takes the Destination's row first and holds it through the send, as a Delivery's
 * job does (ADR 0028), so the two take turns and each counts the other's message against the rate limit
 * and the burst window. It always goes as its own message: where a Delivery would join a Grouped alert,
 * it is held until the burst window ends.
 */
export async function sendSourceAlert(db: Db, alertId: string, deps: SourceAlertDeps): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const [found] = await db
    .select({ destinationId: sourceAlert.destinationId })
    .from(sourceAlert)
    .where(eq(sourceAlert.id, alertId));
  if (found === undefined) return;
  const { destinationId } = found;

  await db.transaction(async (tx) => {
    const [named] =
      destinationId === null
        ? []
        : await tx.select().from(destination).where(eq(destination.id, destinationId)).for("no key update");
    if (destinationId !== null && named === undefined) return;

    // Queued and due by the database's clock, as a Delivery is, so a job that runs again after its
    // attempt committed finds the retry not yet due and ends.
    const [row] = await tx
      .select({ alert: sourceAlert, sourceName: source.name, settings: workspace, email: user.email })
      .from(sourceAlert)
      .innerJoin(source, eq(source.id, sourceAlert.sourceId))
      .innerJoin(workspace, eq(workspace.id, sourceAlert.workspaceId))
      .innerJoin(user, eq(user.id, workspace.ownerUserId))
      .where(
        and(
          eq(sourceAlert.id, alertId),
          eq(sourceAlert.status, "queued"),
          or(isNull(sourceAlert.nextAttemptAt), lte(sourceAlert.nextAttemptAt, sql`now()`)),
        ),
      )
      .for("update", { of: sourceAlert });
    if (row === undefined) return;
    const { alert, settings } = row;
    const record = (outcome: Partial<typeof sourceAlert.$inferInsert>) =>
      tx.update(sourceAlert).set(outcome).where(eq(sourceAlert.id, alertId));
    const hold = (until: Date) => record({ status: "held", nextAttemptAt: until, retryFrom: until });

    // The sign-in address isn't a Destination, so it has no rate limit or burst window to count against.
    // The email sender reads an address and a confirmation from a Destination, and a sign-in address is
    // confirmed by signing in.
    const target: Destination = named ?? {
      id: settings.id,
      workspaceId: settings.id,
      type: "email",
      name: row.email,
      config: { address: row.email },
      secretCiphertext: null,
      secretShownAt: null,
      confirmedAt: alert.createdAt,
      lastError: null,
      lastErrorAt: null,
      createdAt: alert.createdAt,
      updatedAt: alert.createdAt,
    };
    if (target.type === "webhook") {
      await record({ status: "failed", nextAttemptAt: null, lastError: "a webhook can't take a Health alert" });
      return;
    }

    const at = now();
    const sends =
      named === undefined
        ? []
        : await tx
            .select({ at: sentMessage.sentAt })
            .from(sentMessage)
            .where(and(eq(sentMessage.destinationId, target.id), gt(sentMessage.sentAt, new Date(at.getTime() - 60 * 60 * 1000))))
            .orderBy(sentMessage.sentAt);
    // No Severity, so the Severity 5 bypass never applies.
    const decision = scheduleDelivery({ settings, now: at, severity: null, recentSends: sends.map((sent) => sent.at) });
    if (decision.kind !== "send") {
      await hold(decision.until);
      return;
    }
    if (target.type === "email" && deps.emailCap !== undefined) {
      await takeEmailCapTurn(tx, settings.id);
      const capEnd = await emailCapEnd(tx, settings, at);
      if (capEnd !== undefined) {
        await hold(capEnd);
        await queueCapNoticeOnce(tx, settings, capEnd, deps.emailCap);
        return;
      }
    }

    const setError = async (lastError: string | null, lastErrorAt: Date | null) => {
      if (named === undefined) return;
      await tx
        .update(destination)
        .set({ lastError, lastErrorAt })
        .where(and(eq(destination.id, target.id), lastError === null ? isNotNull(destination.lastError) : undefined));
    };
    const attempts = alert.attempts + 1;
    try {
      await deps.senders[target.type].send(
        target,
        sourceAlertContent(alert.kind, row.sourceName, alert.error, deps.appUrl),
        async (secretCiphertext) => {
          await tx.update(destination).set({ secretCiphertext }).where(eq(destination.id, target.id));
        },
      );
    } catch (error) {
      const failed = now();
      const lastError = failureReason(error);
      const retryAt = nextRetry(error, attempts, alert.retryFrom ?? alert.createdAt, failed);
      if (retryAt === undefined) {
        await record({ attempts, status: "failed", nextAttemptAt: null, lastError });
        await setError(lastError, failed);
        return;
      }
      await record({ attempts, nextAttemptAt: retryAt, lastError });
      await deps.retrySourceAlert(tx, alertId, retryAt);
      return;
    }

    const sentAt = now();
    await record({ attempts, status: "sent", sentAt, nextAttemptAt: null, lastError: null });
    await tx
      .insert(sentMessage)
      .values({ workspaceId: settings.id, destinationId: named?.id ?? null, type: target.type, sentAt });
    await setError(null, null);
  });
}
