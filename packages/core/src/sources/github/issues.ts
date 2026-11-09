// A GitHub issues Source: a repo's new issues, not PRs, through the REST API with `since` and an
// ETag (docs: Sources and ingestion, "Issues").
import { z } from "zod";
import { capBody, type ItemDraft, tidyText } from "../item.ts";
import type { Polled } from "../types.ts";
import { type Deferred, githubApi, GithubHttpError, type GithubResponse } from "./client.ts";

// Loose, so the Item's `raw` keeps every field the API gave.
export const issue = z.looseObject({
  number: z.number(),
  title: z.string(),
  body: z.string().nullish(),
  html_url: z.string(),
  user: z.object({ login: z.string() }).nullish(),
  created_at: z.string(),
  updated_at: z.string(),
  pull_request: z.unknown().optional(),
});

const maxPages = 10;
/** How far before its poll a Source starts watching, for GitHub's clock differing from ours. */
const clockMargin = 5 * 60 * 1000;

/**
 * The first poll reads the newest 100 issues created, for the Backfill to take its 50 from. Later
 * polls read the issues updated since the last one, up to 10 pages, and store the last one's
 * `updated_at` as the next `since`. Their first page goes with the stored ETag, so an unchanged
 * answer is a 304 and costs nothing against the rate limit. They capture only issues created since
 * the first poll: an older issue someone edits isn't news, whether or not the Backfill saw it.
 */
export async function pollIssues(
  repo: string,
  fetchState: Record<string, string>,
  get: (url: string, etag?: string) => Promise<GithubResponse | Deferred>,
  now: Date,
): Promise<Polled> {
  const first = fetchState.since === undefined || fetchState.from === undefined;
  const start = new Date(now.getTime() - clockMargin).toISOString();
  const since = fetchState.since ?? start;
  const from = Date.parse(fetchState.from ?? start);
  const query = first
    ? { state: "all", sort: "created", direction: "desc", per_page: "100" }
    : { state: "all", sort: "updated", direction: "asc", since, per_page: "100" };
  let url: string | null = `${githubApi}/repos/${repo}/issues?${new URLSearchParams(query).toString()}`;
  let last = since;
  let etag: string | null = null;
  const drafts: ItemDraft[] = [];
  for (let page = 0; url !== null && page < (first ? 1 : maxPages); page += 1) {
    let answer;
    try {
      answer = await get(url, page === 0 && !first ? fetchState.etag : undefined);
    } catch (error) {
      if (error instanceof GithubHttpError && error.status === 404) {
        const message = `GitHub has no repo ${repo} that the token can read. It may have been renamed, deleted or made private.`;
        throw new Error(message, { cause: error });
      }
      throw error;
    }
    // Put off before anything was read, the whole poll waits; later, it keeps what it has read.
    if ("deferUntil" in answer) {
      if (page === 0) return answer;
      break;
    }
    if (answer.status === 304) {
      await answer.body?.cancel();
      return { notModified: true };
    }
    // The first poll's request isn't the one later polls make, so its ETag is no use to them.
    if (page === 0 && !first) etag = answer.headers.get("etag");
    for (const entry of z.array(issue).parse(await answer.json())) {
      if (!first) last = entry.updated_at;
      // The issues endpoint lists PRs too; a PR reaches Watchdog through a mentions Source.
      const isNew = first || Date.parse(entry.created_at) >= from;
      if (entry.pull_request === undefined && isNew) drafts.push(draft(entry));
    }
    url = nextPage(answer.headers.get("link"));
  }
  const kept = { since: last, from: new Date(from).toISOString(), ...(etag !== null && { etag }) };
  return { drafts, fetchState: kept };
}

/** An issue or a PR from the issues or Search API as an Item draft, keyed by `externalId`. */
export function draft(entry: z.infer<typeof issue>, externalId = String(entry.number)): ItemDraft {
  return {
    externalId,
    url: entry.html_url,
    title: entry.title,
    author: entry.user?.login ?? null,
    body: capBody(tidyText(entry.body ?? "")),
    publishedAt: new Date(entry.created_at),
    raw: entry,
  };
}


/** The `Link` header's next page, only when it is on GitHub's API, since the token goes with it. */
function nextPage(link: string | null) {
  const next = /<([^>]+)>;\s*rel="next"/.exec(link ?? "")?.[1];
  return next !== undefined && URL.parse(next)?.origin === githubApi ? next : null;
}
