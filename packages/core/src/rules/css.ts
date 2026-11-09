// CSS selectors, for a website Source's Region and an Extractor Rule's CSS field (docs: Rule model,
// "CSS selectors"). The HTML is parsed with htmlparser2 and matched with css-select, the two libraries
// cheerio is built on, without its jQuery-style layer.
import { compile, selectAll } from "css-select";
import { parse, type Selector, SelectorType } from "css-what";
import { render } from "dom-serializer";
import { getAttributeValue, getChildren } from "domutils";
import { parseDocument } from "htmlparser2";
import { htmlToText } from "../sources/item.ts";

export const maxSelectorLength = 1000;
/** A deeper document isn't matched: a descendant combinator walks every match's ancestors. */
export const maxDepth = 1000;

/**
 * Why this selector can't run: too long, using :has(), or not a selector css-select can match.
 * Undefined when it can.
 */
export function selectorError(selector: string): "too-long" | "has" | "invalid" | undefined {
  if (selector.length > maxSelectorLength) return "too-long";
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

/** Why a rule can't read a field with this selector, or undefined when it can. */
export function cssError(selector: string): string | undefined {
  switch (selectorError(selector)) {
    case "too-long":
      return `A CSS selector can be at most ${maxSelectorLength.toLocaleString("en")} characters.`;
    case "has":
      return `"${selector}" uses :has(), which Watchdog doesn't run: it walks every descendant of each element it tests.`;
    case "invalid":
      return `"${selector}" isn't a CSS selector Watchdog can run.`;
    case undefined:
      return undefined;
  }
}

type Page = ReturnType<typeof parseDocument>;
type Element = Parameters<typeof getAttributeValue>[0];

function isTooDeep(document: Page) {
  const stack = getChildren(document).map((node) => ({ node, depth: 1 }));
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    if (next.depth > maxDepth) return true;
    const depth = next.depth + 1;
    for (const node of getChildren(next.node)) stack.push({ node, depth });
  }
  return false;
}

/** The HTML parsed, or undefined when it nests too deeply to match. */
export function parseHtml(html: string) {
  const document = parseDocument(html);
  return isTooDeep(document) ? undefined : document;
}

/** As much HTML as a website Item keeps. Matches that don't nest can't add up to more. */
export const maxMatchedHtml = 1024 * 1024;

/**
 * What a validated selector finds, in document order: each match's text, or its `attr` value, trimmed,
 * skipping a match without one. It stops at `limit` values, so a page with thousands of matches costs
 * no more than that to convert. Undefined when the matches add up to more than `maxMatchedHtml`, which
 * only nested ones can, each repeating what is inside it.
 */
export function cssValues(document: Page, selector: string, { attr, limit }: { attr: string | undefined; limit: number }) {
  const values: string[] = [];
  let matched = 0;
  // Every match is an element, which css-select can't infer from a Document.
  for (const match of selectAll<Page | Element, Element>(selector, document)) {
    // htmlparser2 lowercases attribute names.
    const found = attr === undefined ? render(match, { encodeEntities: "utf8" }) : getAttributeValue(match, attr.toLowerCase());
    if (found === undefined) continue;
    matched += found.length;
    if (matched > maxMatchedHtml) return undefined;
    const value = attr === undefined ? htmlToText(found) : found.trim();
    if (value === "") continue;
    values.push(value);
    if (values.length >= limit) break;
  }
  return values;
}
