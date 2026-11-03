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

// Tags that break a line, so the words on either side of them don't run together.
const blockTag =
  /<\/?(?:address|article|aside|blockquote|br|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|img|li|main|nav|ol|p|pre|section|table|td|th|tr|ul)\b[^>]*>/gi;

/** Plain text from an HTML fragment: tags stripped, entities decoded, whitespace collapsed. */
export function htmlToText(html: string) {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(blockTag, " ")
    .replace(/<\/?[a-z][^>]*>/gi, "");
  return decodeHTML(text).replace(/\s+/g, " ").trim();
}

/** Cuts text to at most `maxBodyBytes` of UTF-8, never inside a character. */
export function capBody(text: string) {
  // encodeInto writes only whole characters, and `read` counts the UTF-16 units it took.
  const { read } = new TextEncoder().encodeInto(text, new Uint8Array(maxBodyBytes));
  return text.slice(0, read);
}
