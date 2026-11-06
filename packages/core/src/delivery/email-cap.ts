// Hosted sends a Workspace at most 50 alert mails per local day (docs: Actions and delivery, "The hosted
// email cap"; Business model and licensing). Self-hosted has no cap, so it passes none of this.
import { CronExpressionParser } from "cron-parser";
import { and, delivery, destination, eq, gte, sql, type Tx, user, workspace } from "@watchdog/db";
import type { Mailer } from "../mail/mailer.ts";

const mailsPerDay = 50;

export const capReason = `the hosted limit of ${String(mailsPerDay)} mails a day`;

export interface EmailCap {
  /** Tells the user that the cap was hit. It's sent once a day, and a failure doesn't hold anything up. */
  sendNotice: (to: string, timezone: string) => Promise<void>;
}

export function createEmailCap(mailer: Mailer, from: string | undefined): EmailCap {
  return {
    sendNotice: (to, timezone) =>
      mailer.send({
        to,
        subject: "[Watchdog] Alert mail is held until tomorrow",
        text: [
          `Your Workspace has sent its ${String(mailsPerDay)} alert mails for today.`,
          `Further alert mail is held until midnight (${timezone}), then goes out as one message per address.`,
          "Nothing is lost, and Telegram alerts and webhooks aren't affected.",
        ].join("\n"),
        ...(from !== undefined && { from }),
      }),
  };
}

/**
 * When a Workspace's next mail can go, if it has reached the cap. A Grouped alert is one mail. The caller
 * holds the Workspace's row, so two addresses' sends can't both take the 50th place.
 */
export async function emailCapEnd(tx: Tx, settings: typeof workspace.$inferSelect, now: Date) {
  const midnight = (currentDate: Date) =>
    CronExpressionParser.parse("0 0 0 * * *", { currentDate, tz: settings.timezone });
  // A millisecond on, because the midnight before midnight itself is yesterday's.
  const dayStart = midnight(new Date(now.getTime() + 1)).prev().toDate();
  const [sent] = await tx
    .select({ mails: sql<number>`count(distinct coalesce(${delivery.groupId}, ${delivery.id}))`.mapWith(Number) })
    .from(delivery)
    .innerJoin(destination, eq(delivery.destinationId, destination.id))
    .where(
      and(
        eq(destination.workspaceId, settings.id),
        eq(destination.type, "email"),
        eq(delivery.status, "sent"),
        gte(delivery.sentAt, dayStart),
      ),
    );
  return (sent?.mails ?? 0) < mailsPerDay ? undefined : midnight(now).next().toDate();
}

/** Sends the day's notice unless it has gone. If it can't go, the next held mail tries again. */
export async function sendCapNoticeOnce(
  tx: Tx,
  settings: typeof workspace.$inferSelect,
  until: Date,
  cap: EmailCap,
) {
  if (settings.emailCapNoticeUntil !== null && settings.emailCapNoticeUntil >= until) return;
  const [owner] = await tx.select({ email: user.email }).from(user).where(eq(user.id, settings.ownerUserId));
  if (owner === undefined) return;
  try {
    await cap.sendNotice(owner.email, settings.timezone);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Sending the email cap notice for Workspace ${settings.id} failed: ${reason}\n`);
    return;
  }
  await tx.update(workspace).set({ emailCapNoticeUntil: until }).where(eq(workspace.id, settings.id));
}
