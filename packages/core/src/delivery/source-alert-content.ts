// What a Source Health alert says (docs: Actions and delivery, "Source Health alerts").
import { oneLine } from "./group.ts";

/** Short enough for a Telegram message with the name and the link, whatever a fetch's error says. */
const maxError = 500;

/** The Source's name and its error are untrusted text, so each sender sends them as text. */
export interface SourceAlertMessage {
  health: "failing" | "recovered";
  source: string;
  /** The Source's last error when it became failing. */
  error: string | null;
  /** The Sources screen. */
  link: string;
}

export function sourceAlertContent(
  health: SourceAlertMessage["health"],
  source: string,
  error: string | null,
  appUrl: string,
): SourceAlertMessage {
  return { health, source: oneLine(source), error, link: new URL("/sources", appUrl).href };
}

/** A mail's subject, after the `[Watchdog]` every alert mail starts with. */
export const sourceAlertSubject = ({ health, source }: SourceAlertMessage) => `Source ${health} · ${source}`;

/** Plain text, the same lines in Telegram and in a mail. */
export function sourceAlertText({ health, source, error, link }: SourceAlertMessage) {
  if (health === "recovered") return `Source ${source} recovered\n${link}`;
  const why = error === null || error === "" ? "" : `${error.slice(0, maxError).replace(/[\uD800-\uDBFF]$/, "")}\n`;
  return `Source ${source} is failing\n${why}${link}`;
}
