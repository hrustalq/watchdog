// A website Source's page: fetched statically, narrowed to its Region and read as text (docs: Sources
// and ingestion, "Website change detection"). The HTML is parsed with htmlparser2 and the Region
// matched with css-select, as an Extractor Rule's CSS field will be (Rule model, "CSS selectors").
import { compile, selectAll } from "css-select";
import { parse, type Selector, SelectorType } from "css-what";
import { render } from "dom-serializer";
import { findOne, getChildren, textContent } from "domutils";
import { parseDocument } from "htmlparser2";
import type { createEgressFetch } from "../../egress/egress.ts";
import { withoutMatches } from "../../rules/regex.ts";
import { htmlToText } from "../item.ts";

export const maxRegionLength = 1000;
/** A deeper page isn't read: matching a descendant combinator walks every match's ancestors. */
const maxDepth = 1000;

/**
 * Why a website Source can't watch this Region selector: too long, using :has(), or not a selector
 * css-select can match. Undefined when it can.
 */
export function regionError(selector: string): "too-long" | "has" | "invalid" | undefined {
  if (selector.length > maxRegionLength) return "too-long";
  try {
    // css-select refuses what css-what parses but it can't match, such as ::before.
    compile(selector);
    return usesHas(parse(selector)) ? "has" : undefined;
  } catch {
    return "invalid";
  }
}

/** :has() walks every descendant of each element it tests, and nested ones multiply. */
const usesHas = (selectors: Selector[][]): boolean =>
  selectors.some((tokens) =>
    tokens.some(
      (token) => token.type === SelectorType.Pseudo && (token.name === "has" || (Array.isArray(token.data) && usesHas(token.data))),
    ),
  );

/**
 * Fetches the page through the egress guard and returns its HTML and the URL it came from after any
 * redirects, or throws why it can't.
 */
export async function fetchPage(url: string, deps: { fetch: ReturnType<typeof createEgressFetch> }) {
  const response = await deps.fetch(url, { headers: { accept: "text/html, application/xhtml+xml;q=0.9" } });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${url} answered ${String(response.status)} ${response.statusText}`.trim());
  }
  const contentType = response.headers.get("content-type");
  const type = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  // A PDF or a JSON document has no page to compare.
  if (type !== "text/html" && type !== "application/xhtml+xml") {
    await response.body?.cancel();
    throw new Error(`${url} answered with ${type.slice(0, 100) || "no content type"}, not an HTML page`);
  }
  const html = decode(new Uint8Array(await response.arrayBuffer()), contentType);
  return { html, finalUrl: response.url || url };
}

/**
 * The page's title, and the Region's HTML (each match's outer HTML, in document order) and text. A
 * Source without a Region watches the whole <body>. Throws when the Region matches nothing.
 */
export function readPage(html: string, region: string | undefined) {
  const document = parseDocument(html);
  if (tooDeep(document)) throw new Error(`The page is nested more than ${String(maxDepth)} elements deep, too deep to read`);
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

function tooDeep(document: ReturnType<typeof parseDocument>) {
  const stack = getChildren(document).map((node) => ({ node, depth: 1 }));
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    if (next.depth > maxDepth) return true;
    const depth = next.depth + 1;
    for (const node of getChildren(next.node)) stack.push({ node, depth });
  }
  return false;
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
