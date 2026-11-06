// One message carrying several alerts to a Destination (docs: Actions and delivery, "Grouping and rate
// limits"). The hosted email cap sends held mail in this shape too.
import { type AlertItem, itemHeadline } from "./content.ts";

const maxLines = 50;
/** So one Item with an enormous title can't push the others out of a message with a limit. */
const maxTitle = 200;

/** As with an alert, the lines hold untrusted Item text. */
export interface GroupedAlert {
  count: number;
  lines: ReturnType<typeof itemHeadline>[];
  /** Where the Items past the last line can be read. */
  feedLink: string;
}

/** Takes the Items in the order they should be listed. */
export function groupedAlert(items: Omit<AlertItem, "summary">[], appUrl: string): GroupedAlert {
  return {
    count: items.length,
    lines: items.slice(0, maxLines).map((item) => itemHeadline(item, appUrl)),
    feedLink: new URL("/", appUrl).href,
  };
}

/** A title's line breaks would look like another Item's line, so they go. */
export function oneLine(title: string) {
  const flat = title.replace(/\s+/g, " ");
  // A cut between the two halves of an emoji would leave text a receiver can refuse.
  return flat.length <= maxTitle ? flat : `${flat.slice(0, maxTitle - 1).replace(/[\uD800-\uDBFF]$/, "")}…`;
}

/** Plain text. A receiver with a length limit gets fewer whole lines, and the rest count into the link to the Feed. */
export function groupedAlertText({ count, lines, feedLink }: GroupedAlert, maxLength = Infinity) {
  const more = (left: number) => (left > 0 ? `\nand ${String(left)} more: ${feedLink}` : "");
  let text = `${String(count)} alerts`;
  let listed = 0;
  for (const { title, rating, link } of lines) {
    const line = `\n${oneLine(title)} · ${rating} · ${link}`;
    if (text.length + line.length + more(count - listed - 1).length > maxLength) break;
    text += line;
    listed += 1;
  }
  return text + more(count - listed);
}
