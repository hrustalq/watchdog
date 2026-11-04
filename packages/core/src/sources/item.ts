// The Item envelope every Source type fills (docs: Processing pipeline, "Item envelope").
import { decodeHTML } from "entities";

/** An Item as a Source hands it over: the envelope without what Watchdog sets on capture. */
export interface ItemDraft {
  /** The Source's own ID for the entry, or its URL when it has none: the dedup key. */
  externalId: string;
  url: string | null;
  title: string | null;
  author: string | null;
  /** Plain text, at most `maxBodyBytes` of UTF-8. */
  body: string;
  publishedAt: Date | null;
  /** The entry as the Source gave it, for Source-specific extras. */
  raw: object;
}

export const maxBodyBytes = 32 * 1024;

// Tags that end a paragraph, a line or a word, so the text on either side doesn't run together.
// The name ends at a space, "/" or ">", so a custom element such as <p-note> isn't a <p>.
const tags = (names: string[]) =>
  new RegExp(String.raw`<\/?(?:${names.join("|")})(?=[\s/>])[^<>]*>`, "gi");
const paragraphTag = tags([
  ...["address", "article", "aside", "blockquote", "details", "dl", "figcaption", "figure"],
  ...["footer", "h[1-6]", "header", "hr", "main", "nav", "ol", "p", "pre", "section", "table"],
  "ul",
]);
const lineTag = tags(["br", "caption", "dd", "div", "dt", "li", "summary", "tr"]);
const wordTag = tags(["img", "td", "th"]);

/** Plain text from an HTML fragment: tags stripped, entities decoded, a line per block. */
export function htmlToText(html: string) {
  // Every pattern stays linear on hostile input: an unclosed comment or script runs to the end
  // instead of being retried from each opener, and a tag can't span another "<".
  const text = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<(script|style)\b[^<>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
    // A line break in HTML source is only a space; the tags decide where lines break.
    .replace(/\s+/g, " ")
    .replace(paragraphTag, "\f")
    .replace(lineTag, "\n")
    .replace(wordTag, " ")
    .replace(/<\/?[a-z][^<>]*>/gi, "")
    // A run of breaks is one blank line when a paragraph ends in it, else one line break, so
    // "</li><li>" doesn't leave a blank line.
    .replace(/[\n\f][ \n\f]*/g, (run) => (run.includes("\f") ? "\n\n" : "\n"));
  return tidyText(decodeHTML(text));
}

/** Spaces collapsed within each line, lines trimmed, and at most one blank line in a row. */
export function tidyText(text: string) {
  return text
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Cuts text to at most `maxBodyBytes` of UTF-8, never inside a character. */
export function capBody(text: string) {
  // encodeInto writes only whole characters, and `read` counts the UTF-16 units it took.
  const { read } = new TextEncoder().encodeInto(text, new Uint8Array(maxBodyBytes));
  return text.slice(0, read);
}
