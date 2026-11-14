// The website Source type: one page polled on its schedule, compared with its Baseline, and each change
// captured as one Item (docs: Sources and ingestion, "Website change detection").
import { createHash } from "node:crypto";
import { diffLines } from "diff";
import { z } from "zod";
import { type Rendered, renderTimeout } from "../../render/renderer.ts";
import { capBody } from "../item.ts";
import type { SourceTypeImpl } from "../types.ts";
import { fetchPage, normalise, readPage } from "./page.ts";
import { checkRobots } from "./robots.ts";

/** How a website is read: fetched as served, rendered by Obscura, or rendered by the Chromium fallback. */
export const renderModes = ["static", "obscura", "chromium"] as const;

const config = z.object({
  url: z.string(),
  region: z.string().optional(),
  ignore: z.array(z.string()),
  render: z.enum(renderModes),
  /** Self-hosted only: skip robots.txt, which the user turned on behind ADR 0015's warning. */
  ignoreRobots: z.literal(true).optional(),
});

const rendererNames = { obscura: "Obscura", chromium: "Chromium" } as const;

/** The most HTML an Item keeps in `raw.html`. Over it, none is kept: a cut document misleads selectors. */
export const maxHtmlBytes = 1024 * 1024;

export const website: SourceTypeImpl = {
  config,
  // The first fetch stores the Baseline instead.
  backfill: null,
  poll: async (source, deps) => {
    const parsed = config.safeParse(source.config);
    if (!parsed.success) throw new Error("The Source's config has no page URL");
    const { url, region, ignore, render, ignoreRobots } = parsed.data;
    const renderer = render === "static" ? undefined : deps[render];
    if (render !== "static" && renderer === undefined) throw new Error(`The ${rendererNames[render]} renderer isn't running`);
    const robots = deps.mode !== "self-hosted" || ignoreRobots !== true;
    if (robots) await checkRobots(url, deps);
    const { html, finalUrl, blocked = [] }: Omit<Rendered, "title"> =
      renderer === undefined
        ? await fetchPage(url, deps)
        : await renderer.render(url, {
            timeout: renderTimeout,
            ...(region !== undefined && { region }),
            ...(deps.signal && { signal: deps.signal }),
          });
    // A redirect leads to a page robots.txt hasn't been asked about. It was fetched, but isn't read.
    if (robots && finalUrl !== url) await checkRobots(finalUrl, deps);

    const page = readPage(html, region);
    const text = normalise(page.text, ignore);
    const hash = createHash("sha256").update(text).digest("hex");
    const baseline = source.fetchState;
    if (baseline.hash === hash) return { notModified: true };
    // The new text becomes the Baseline in the transaction that captures its Item.
    const fetchState = { text, hash };
    if (baseline.hash === undefined) return { drafts: [], fetchState };

    const keepHtml = Buffer.byteLength(page.html) <= maxHtmlBytes;
    const notes = [
      ...(keepHtml ? [] : ["The page HTML was too large to keep: it is over 1 MB."]),
      ...(blocked.length === 0 ? [] : [`Requests the page made were blocked: ${[...new Set(blocked)].join("; ")}.`]),
    ];
    const draft = {
      // The fetch time keeps a page that returns to an earlier state a new change.
      externalId: `${hash}:${deps.now.toISOString()}`,
      url,
      title: `${page.title ?? url} changed`,
      author: null,
      body: capBody(lineDiff(baseline.text ?? "", text)),
      publishedAt: deps.now,
      raw: keepHtml ? { text, html: page.html } : { text },
      ...(notes.length > 0 && { captureNote: notes.join(" ") }),
    };
    return { drafts: [draft], fetchState };
  },
};

/** Past this many changed lines, or this many ms, the shortest diff costs too much to find. */
const maxEditLength = 1000;
const diffTimeout = 1000;

/** Added lines as `+ <line>` and removed ones as `- <line>`, unchanged ones left out. */
function lineDiff(before: string, after: string) {
  // A last line without its newline would differ from the same line with one.
  const changes = diffLines(`${before}\n`, `${after}\n`, { maxEditLength, timeout: diffTimeout });
  if (changes === undefined) return roughDiff(before.split("\n"), after.split("\n"));
  return changes
    .filter((change) => change.added || change.removed)
    .flatMap((change) => change.value.replace(/\n$/, "").split("\n").map((line) => `${change.added ? "+" : "-"} ${line}`))
    .join("\n");
}

/** A diff that isn't the shortest: every line between the lines both texts start and end with. */
function roughDiff(before: string[], after: string[]) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end++;
  }
  return [
    ...before.slice(start, before.length - end).map((line) => `- ${line}`),
    ...after.slice(start, after.length - end).map((line) => `+ ${line}`),
  ].join("\n");
}
