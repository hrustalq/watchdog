// Sends alerts through the Mailer (docs: Actions and delivery, "Email addresses" and "Alerts").
import { z } from "zod";
import { ratingScale } from "../agent/rating.ts";
import type { Mailer } from "../mail/mailer.ts";
import type { AlertMessage } from "./content.ts";
import { FinalSendError, type Sender } from "./deliver.ts";
import { groupedAlertText, oneLine } from "./group.ts";

/** An email Destination's settings: one valid address, because a list would reach people who never confirmed. */
export const emailDestinationConfig = z.object({ address: z.email() });

/** What the Rating scale says a level means, which reads as a word for how urgent an Item is. */
function severityWord(severity: number | null) {
  const meaning = ratingScale.severity.levels.find(({ level }) => level === severity)?.meaning ?? "unrated";
  return `${meaning.charAt(0).toUpperCase()}${meaning.slice(1)}`;
}

function alertText({ title, source, rating, summary, link, why }: AlertMessage) {
  const heading = `${title}\nSource: ${source}\nRating: ${rating}`;
  const body = summary === null || summary === "" ? heading : `${heading}\n\n${summary}`;
  return `${body}\n\n${link}\nWhy it fired: ${why}`;
}

/**
 * Plain text, with no markup part, so nothing in an Item's text can format the mail. A subject is a single
 * header line, so a title's line breaks go. On hosted the mail server is the operator's and the Log is the
 * user's, so the server's own answer goes to the worker's log.
 */
export function createEmailSender(mailer: Mailer, from: string | undefined): Sender {
  return {
    send: async (destination, message) => {
      if (destination.confirmedAt === null) throw new FinalSendError("the address isn't confirmed yet");
      const parsed = emailDestinationConfig.safeParse(destination.config);
      if (!parsed.success) throw new FinalSendError("the Destination has no valid address");

      const grouped = "lines" in message;
      const subject = grouped
        ? `${String(message.count)} alerts`
        : `${severityWord(message.severity)} · ${oneLine(message.title)}`;
      try {
        await mailer.send({
          to: parsed.data.address,
          subject: `[Watchdog] ${subject}`,
          text: grouped ? groupedAlertText(message) : alertText(message),
          ...(from !== undefined && { from }),
        });
      } catch (error) {
        const answer = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Sending a mail to Destination ${destination.id} failed: ${answer}\n`);
        throw new Error("the mail server can't be reached or refused the mail", { cause: error });
      }
    },
  };
}
