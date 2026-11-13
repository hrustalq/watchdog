// A website Source's page: fetched statically, narrowed to its Region and read as text (docs: Sources
// and ingestion, "Website change detection"). The Region is a CSS selector, matched as an Extractor
// Rule's CSS field is (Rule model, "CSS selectors").
import { selectAll } from "css-select";
import { render } from "dom-serializer";
import { findOne, getChildren, textContent } from "domutils";
import type { createEgressFetch } from "../../egress/egress.ts";
import { maxDepth, parseHtml } from "../../rules/css.ts";
import { withoutMatches } from "../../rules/regex.ts";
import { htmlToText } from "../item.ts";

export { maxSelectorLength as maxRegionLength, selectorError as regionError } from "../../rules/css.ts";

/**
 * Fetches the page through the egress guard and returns its HTML and the URL it came from after any
 * redirects, or throws why it can't. A stopped poll's signal ends the fetch with it.
 */
export async function fetchPage(
  url: string,
  deps: { fetch: ReturnType<typeof createEgressFetch>; signal?: AbortSignal },
) {
  const response = await deps.fetch(url, {
    headers: { accept: "text/html, application/xhtml+xml;q=0.9" },
    ...(deps.signal && { signal: deps.signal }),
  });
  const contentType = response.headers.get("content-type");
  const problem = unwatchable(url, { status: response.status, statusText: response.statusText, contentType });
  if (problem !== undefined) {
    await response.body?.cancel();
    throw new Error(problem);
  }
  const html = decode(new Uint8Array(await response.arrayBuffer()), contentType);
  return { html, finalUrl: response.url || url };
}

/**
 * Why a page's answer, fetched or rendered, can't be watched: an error status, or a type that isn't
 * HTML, because a PDF or a JSON document has no page to compare. Undefined when it can.
 */
export function unwatchable(url: string, answer: { status: number; statusText: string; contentType: string | null }) {
  if (answer.status < 200 || answer.status > 299) return `${url} answered ${String(answer.status)} ${answer.statusText}`.trim();
  const type = answer.contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type !== "text/html" && type !== "application/xhtml+xml") {
    return `${url} answered with ${type.slice(0, 100) || "no content type"}, not an HTML page`;
  }
  return undefined;
}

/**
 * The page's title, and the Region's HTML (each match's outer HTML, in document order) and text. A
 * Source without a Region watches the whole <body>. Throws when the Region matches nothing.
 */
export function readPage(html: string, region: string | undefined) {
  const document = parseHtml(html);
  if (document === undefined) throw new Error(`The page is nested more than ${String(maxDepth)} elements deep, too deep to read`);
  const titleElement = findOne((element) => element.name === "title", document);
  const title = titleElement === null ? "" : textContent(titleElement).replace(/\s+/g, " ").trim();
  let matches: Parameters<typeof render>[0][];
  if (region === undefined) {
    // htmlparser2 adds no <body> a page leaves out, so such a page is read whole, but its doctype.
    const body = findOne((element) => element.name === "body", document);
    matches = [body ?? getChildren(document).filter((node) => !("name" in node && node.name === "!doctype"))];
  } else {
    matches = selectAll(region, document);
    if (matches.length === 0) throw new Error(`The region ${region} matched nothing on the page`);
  }
  // Characters stay UTF-8 rather than becoming entities, so the HTML cap counts the page's own bytes.
  const parts = matches.map((match) => render(match, { encodeEntities: "utf8" }));
  return {
    title: title === "" ? null : title,
    html: parts.join("\n"),
    text: parts.map(htmlToText).join("\n"),
  };
}

/** The text without the ignore patterns' matches, each line's whitespace collapsed, blank lines dropped. */
export function normalise(text: string, ignore: string[]) {
  return ignore
    // Postgres refuses U+0000 in the jsonb that keeps the Baseline.
    .reduce((kept, pattern) => withoutMatches(pattern, kept), text.replaceAll("\0", ""))
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
}

/** Decodes the body in the charset the response or a <meta> tag names, UTF-8 otherwise. */
function decode(bytes: Uint8Array, contentType: string | null) {
  const declared =
    /charset="?([\w.:-]+)/i.exec(contentType ?? "")?.[1] ??
    /<meta[^>]+charset=["']?([\w.:-]+)/i.exec(new TextDecoder("latin1").decode(bytes.subarray(0, 1024)))?.[1];
  try {
    return new TextDecoder(declared ?? "utf-8").decode(bytes);
  } catch {
    // An unknown charset label.
    return new TextDecoder().decode(bytes);
  }
}
