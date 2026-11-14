// What a Source Health alert says (docs: Actions and delivery, "Source Health alerts").
import { oneLine } from "./group.ts";

/** Short enough for a Telegram message with the names and the link, whatever a fetch's error says. */
const maxError = 500;
/** A session watching many chats names some and leaves the rest to the Sources screen, so the message fits. */
const maxNames = 10;

/** The Sources' names and their error are untrusted text, so each sender sends them as text. */
export interface SourceAlertMessage {
  health: "failing" | "recovered";
  /**
   * The Sources that changed together, in the order they changed: one for a lone Source, and more when
   * one change took several (docs: Actions and delivery, "Source Health alerts").
   */
  sources: string[];
  /** How many of the change's Sources the message leaves to the Sources screen. */
  unnamed: number;
  /** The error the Sources share when they became failing. */
  error: string | null;
  /** The Sources screen. */
  link: string;
}

/** How many Sources the message speaks for. */
export const sourceAlertCount = ({ sources, unnamed }: SourceAlertMessage) => sources.length + unnamed;

/** The one Source an alert that names a single Source speaks for. */
function alone({ sources, unnamed }: SourceAlertMessage) {
  const [only, ...others] = sources;
  return only !== undefined && others.length === 0 && unnamed === 0 ? only : undefined;
}

/** An alert about a Source that changed on its own, which reads as it always has. */
export function sourceAlertContent(
  health: SourceAlertMessage["health"],
  source: string,
  error: string | null,
  appUrl: string,
): SourceAlertMessage {
  return groupedSourceAlertContent(health, [source], error, appUrl);
}

/**
 * An alert about the Sources one change made failing or recovering. It names the first `maxNames`, and
 * counts the rest, which the Sources screen lists.
 */
export function groupedSourceAlertContent(
  health: SourceAlertMessage["health"],
  sources: string[],
  error: string | null,
  appUrl: string,
): SourceAlertMessage {
  const named = sources.slice(0, maxNames).map((name) => oneLine(name));
  return {
    health,
    sources: named,
    unnamed: sources.length - named.length,
    error,
    link: new URL("/sources", appUrl).href,
  };
}

/** A mail's subject, after the `[Watchdog]` every alert mail starts with. */
export function sourceAlertSubject(message: SourceAlertMessage) {
  const only = alone(message);
  if (only !== undefined) return `Source ${message.health} · ${only}`;
  return `${String(sourceAlertCount(message))} Sources ${message.health}`;
}

/** The error line, which a recovery has none of. */
const why = (error: string | null) =>
  error === null || error === "" ? "" : `${error.slice(0, maxError).replace(/[\uD800-\uDBFF]$/, "")}\n`;

/** Plain text, the same lines in Telegram and in a mail. */
export function sourceAlertText(message: SourceAlertMessage) {
  const { health, sources, unnamed, link } = message;
  const only = alone(message);
  if (only !== undefined) {
    if (health === "recovered") return `Source ${only} recovered\n${link}`;
    return `Source ${only} is failing\n${why(message.error)}${link}`;
  }
  const count = String(sourceAlertCount(message));
  const heading = health === "recovered" ? `${count} Sources recovered` : `${count} Sources are failing`;
  const names = sources.map((name) => `\n· ${name}`).join("");
  const rest = unnamed === 0 ? "" : `\nand ${String(unnamed)} more`;
  return `${heading}\n${why(message.error)}${names}${rest}\n${link}`;
}
