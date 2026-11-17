import Link from "next/link";
import { dataBox, textBox, textLink } from "@/components/field-classes";
import { Notice } from "@/components/notice";
import { Section } from "@/components/section";
import { Timestamp } from "@/components/timestamp";

/**
 * How to bring the bot into a chat for a bot Source. It works without JavaScript, and the text box
 * copies from a keyboard. The guided setup passes its own reload link and a way to carry on once
 * the bot has answered; the Sources screen leaves both at their defaults.
 */
export function TelegramLinkPanel({
  link: { name, code, expiresAt },
  bot,
  reloadHref = "/sources",
  continueHref,
}: {
  link: { name: string; code: string; expiresAt: Date };
  bot: string | undefined;
  reloadHref?: string;
  continueHref?: string;
}) {
  return (
    <Section id="telegram-link" title={<>Bring the bot into a chat for {name}</>} tone="raised">
      {bot === undefined ? (
        <Notice role="alert" tone="alarm">
          Watchdog couldn&apos;t reach Telegram to get the bot&apos;s name, so the link isn&apos;t ready. Reload this page
          in a moment.
        </Notice>
      ) : (
        <>
          {/* Keyed by the code, so a new link is announced even though the rest of the page stays. */}
          <Notice key={code} role="status" tone="plain">
            The code in this link and command works once and expires at <Timestamp at={expiresAt} className="whitespace-nowrap" />.
          </Notice>
          <p className="text-sm">
            For a group,{" "}
            <a href={`https://t.me/${bot}?startgroup=${code}`} target="_blank" rel="noreferrer" className={textLink}>
              choose it in Telegram
            </a>
            . The bot joins it and starts watching.
          </p>
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor="telegram-command">For a channel, make @{bot} an admin and post this there:</label>
            {/* @bot in the command, because a bot in a group is only sure to get commands addressed to it. */}
            <textarea
              id="telegram-command"
              readOnly
              rows={2}
              value={`/start@${bot} ${code}`}
              className={`${textBox} ${dataBox} resize-none py-1.5 field-sizing-content`}
            />
          </div>
          <p className="text-sm text-muted-foreground">
            <Link href={reloadHref} prefetch={false} className={textLink}>
              Reload this page
            </Link>{" "}
            after the bot replies. No reply within a minute? Get a new link, which replaces this one, and try again.
          </p>
          {continueHref === undefined ? null : (
            <p className="text-sm">
              Once the bot has replied,{" "}
              <Link href={continueHref} className={textLink}>
                continue the setup
              </Link>
              .
            </p>
          )}
        </>
      )}
    </Section>
  );
}
