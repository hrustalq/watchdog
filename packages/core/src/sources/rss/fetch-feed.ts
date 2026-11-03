// Fetches an RSS 2.0, RSS 1.0 (RDF) or Atom 1.0 feed and maps its entries to Item drafts
// (docs: Sources and ingestion; Processing pipeline, "Item envelope").
import { type AtomFeed, parseFeed, type RdfFeed, type RssFeed } from "feedsmith";
import rootPackage from "../../../../../package.json" with { type: "json" };
import type { createEgressFetch } from "../../egress/egress.ts";
import { capBody, htmlToText, type ItemDraft } from "../item.ts";

/** Conditional-request state kept on the Source between fetches. */
export interface FetchState {
  etag?: string;
  lastModified?: string;
}

export interface FetchFeedDeps {
  /** The egress guard's fetch: a feed URL is user input. */
  fetch: ReturnType<typeof createEgressFetch>;
}

export type FetchFeedResult =
  | { notModified: true }
  | { entries: ItemDraft[]; fetchState: FetchState; feedTitle: string | null };

const userAgent = `Watchdog/${rootPackage.version} (+https://github.com/hrustalq/watchdog)`;

export async function fetchFeed(
  url: string,
  fetchState: FetchState,
  deps: FetchFeedDeps,
): Promise<FetchFeedResult> {
  const headers: Record<string, string> = {
    "user-agent": userAgent,
    accept: [
      "application/rss+xml, application/atom+xml, application/rdf+xml",
      "application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8",
    ].join(", "),
  };
  if (fetchState.etag !== undefined) headers["if-none-match"] = fetchState.etag;
  if (fetchState.lastModified !== undefined) headers["if-modified-since"] = fetchState.lastModified;

  const response = await deps.fetch(url, { headers });
  if (response.status === 304) {
    await response.body?.cancel();
    return { notModified: true };
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${url} answered ${String(response.status)} ${response.statusText}`.trim());
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = decode(bytes, response.headers.get("content-type"));

  let parsed;
  try {
    parsed = parseFeed(text);
  } catch (error) {
    throw new Error(`${url} is not an RSS or Atom feed`, { cause: error });
  }
  // Relative links resolve against where the feed was finally fetched from.
  const base = response.url || url;
  let entries: (ItemDraft | undefined)[];
  let feedTitle: string | undefined;
  switch (parsed.format) {
    case "rss":
    case "rdf":
      entries = (parsed.feed.items ?? []).map((item) => fromRss(item, base));
      feedTitle = parsed.feed.title;
      break;
    case "atom":
      entries = (parsed.feed.entries ?? []).map((entry) => fromAtom(entry, base));
      feedTitle = atomText(parsed.feed.title);
      break;
    case "json":
      throw new Error(`${url} is not an RSS or Atom feed`);
  }

  const etag = response.headers.get("etag");
  const lastModified = response.headers.get("last-modified");
  return {
    entries: entries.filter((entry) => entry !== undefined),
    fetchState: { ...(etag !== null && { etag }), ...(lastModified !== null && { lastModified }) },
    feedTitle: orNull(feedTitle),
  };
}

// RSS 2.0 and RSS 1.0 items share these fields; RSS 1.0 has no guid, pubDate or author.
function fromRss(
  item: RssFeed.Item<string> | RdfFeed.Item<string>,
  base: string,
): ItemDraft | undefined {
  const rss: Partial<RssFeed.Item<string>> = item;
  const url = resolve(item.link, base);
  const externalId = orNull(rss.guid?.value) ?? url;
  if (externalId === null) return undefined;
  const html = item.content?.encoded ?? item.description ?? "";
  const person = rss.authors?.[0];
  return {
    externalId,
    url,
    title: orNull(collapse(item.title ?? "")),
    author: orNull(item.dc?.creators?.[0] ?? person?.name ?? person?.email),
    body: capBody(htmlToText(html)),
    publishedAt: date(rss.pubDate ?? item.dc?.dates?.[0]),
    raw: item,
  };
}

function fromAtom(entry: AtomFeed.Entry<string>, base: string): ItemDraft | undefined {
  // Only the alternate link is the entry itself; self, edit, enclosure and replies aren't.
  const link = entry.links?.find((candidate) => (candidate.rel ?? "alternate") === "alternate");
  const url = resolve(link?.href, base);
  const externalId = orNull(entry.id) ?? url;
  if (externalId === null) return undefined;
  return {
    externalId,
    url,
    title: orNull(atomText(entry.title)),
    author: orNull(entry.authors?.[0]?.name),
    body: capBody(atomText(entry.content ?? entry.summary)),
    publishedAt: date(entry.published ?? entry.updated),
    raw: entry,
  };
}

/** Atom text as plain text: "html" and "xhtml" carry markup, "text" (the default) doesn't. */
function atomText(text: { value?: string; type?: string } | undefined) {
  if (text?.value === undefined) return "";
  const markup = text.type === "html" || text.type === "xhtml";
  return markup ? htmlToText(text.value) : collapse(text.value);
}

function collapse(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

/** An absolute http or https URL, or null: a feed can't hand the Feed a javascript: link. */
function resolve(href: string | undefined, base: string) {
  const url = href === undefined ? null : URL.parse(href.trim(), base);
  return url?.protocol === "http:" || url?.protocol === "https:" ? url.href : null;
}

function date(value: string | undefined) {
  if (value === undefined) return null;
  // A date-time with no offset would otherwise be read in the worker's own time zone.
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(value) ? `${value}Z` : value);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

function orNull(value: string | undefined) {
  return value === undefined || value.trim() === "" ? null : value;
}

/** Decodes the body in the charset the response or the XML declaration names, UTF-8 otherwise. */
function decode(bytes: Uint8Array, contentType: string | null) {
  const declared =
    /charset="?([\w.:-]+)/i.exec(contentType ?? "")?.[1] ??
    /^\s*<\?xml[^>]*encoding=["']([\w.:-]+)/.exec(
      new TextDecoder("latin1").decode(bytes.subarray(0, 200)),
    )?.[1];
  try {
    return new TextDecoder(declared ?? "utf-8").decode(bytes);
  } catch {
    // An unknown charset label.
    return new TextDecoder().decode(bytes);
  }
}
