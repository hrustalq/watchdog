// Hosted sends a Workspace at most 50 alert mails per local day (docs: Actions and delivery, "The hosted
// email cap"; Business model and licensing). Self-hosted has no cap, so it passes none of this.
import { and, type Db, delivery, destination, eq, sql, type Tx, user, workspace } from "@watchdog/db";
import type { Mailer } from "../mail/mailer.ts";

const mailsPerDay = 50;

export const capReason = `the hosted limit of ${String(mailsPerDay)} mails a day`;

export interface EmailCap {
  /** Queues the notice on the transaction that holds the mail, so it commits with the hold and goes after. */
  queueNotice: (tx: Tx, workspaceId: string) => Promise<void>;
}

/**
 * Makes a Workspace's mail take turns until the transaction ends, so two addresses can't both take the
 * 50th place. Not a lock on the row, because it's held through a send, and a save of the Workspace
 * shouldn't wait for a mail server.
 */
export async function takeEmailCapTurn(tx: Tx, workspaceId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))`);
}

/**
 * When a Workspace's next mail can go, if it has reached the cap. A Grouped alert is one mail. The local
 * day comes from Postgres, because a cron iterator throws on a day whose midnight doesn't exist.
 */
export async function emailCapEnd(tx: Tx, settings: typeof workspace.$inferSelect, now: Date) {
  const timezone = sql`${settings.timezone}::text`;
  const today = sql`(${now.toISOString()}::timestamptz at time zone ${timezone})::date`;
  const [sent] = await tx
    .select({
      mails: sql<number>`count(distinct coalesce(${delivery.groupId}, ${delivery.id}))`.mapWith(Number),
      dayEnd: sql<Date>`((${today} + 1)::timestamp at time zone ${timezone})`.mapWith(delivery.sentAt),
    })
    .from(delivery)
    .innerJoin(destination, eq(delivery.destinationId, destination.id))
    .where(
      and(
        eq(destination.workspaceId, settings.id),
        eq(destination.type, "email"),
        eq(delivery.status, "sent"),
        sql`${delivery.sentAt} >= (${today}::timestamp at time zone ${timezone})`,
      ),
    );
  return sent === undefined || sent.mails < mailsPerDay ? undefined : sent.dayEnd;
}

/** Queues the day's notice unless it has been queued already. */
export async function queueCapNoticeOnce(
  tx: Tx,
  settings: typeof workspace.$inferSelect,
  until: Date,
  cap: EmailCap,
) {
  if (settings.emailCapNoticeUntil !== null && settings.emailCapNoticeUntil >= until) return;
  await tx.update(workspace).set({ emailCapNoticeUntil: until }).where(eq(workspace.id, settings.id));
  await cap.queueNotice(tx, settings.id);
}

/** Tells a Workspace's owner that the cap was hit. Its job runs this, and retries it if it throws. */
export async function sendEmailCapNotice(db: Db, workspaceId: string, mailer: Mailer, from: string | undefined) {
  const [found] = await db
    .select({ email: user.email, timezone: workspace.timezone })
    .from(workspace)
    .innerJoin(user, eq(workspace.ownerUserId, user.id))
    .where(eq(workspace.id, workspaceId));
  if (found === undefined) return;
  await mailer.send({
    to: found.email,
    subject: "[Watchdog] Alert mail is held until tomorrow",
    text: [
      `Your Workspace has sent its ${String(mailsPerDay)} alert mails for today.`,
      `Further alert mail is held until midnight (${found.timezone}), then goes out as one message per address.`,
      "Nothing is lost, and Telegram alerts and webhooks aren't affected.",
    ].join("\n"),
    ...(from !== undefined && { from }),
  });
}
