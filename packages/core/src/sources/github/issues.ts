// A GitHub issues Source: a repo's new issues, not PRs, through the REST API with `since` and an
// ETag (docs: Sources and ingestion, "Issues").
import { z } from "zod";
import { capBody, type ItemDraft, tidyText } from "../item.ts";
import type { Polled } from "../types.ts";
import { type Deferred, githubApi, GithubHttpError, type GithubResponse } from "./client.ts";

// Loose, so the Item's `raw` keeps every field the API gave.
const issue = z.looseObject({
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
const backfillWindow = 7 * 24 * 60 * 60 * 1000;

/**
 * Reads the issues updated since the last poll, up to 10 pages, and stores the last one's
 * `updated_at` as the next `since`. The first page goes with the stored ETag, so an unchanged
 * answer is a 304 and costs nothing against the rate limit.
 */
export async function pollIssues(
  repo: string,
  fetchState: Record<string, string>,
  get: (url: string, etag?: string) => Promise<GithubResponse | Deferred>,
  now: Date,
): Promise<Polled> {
  // The first poll looks back as far as the Backfill window.
  const since = fetchState.since ?? new Date(now.getTime() - backfillWindow).toISOString();
  const query = new URLSearchParams({ state: "all", sort: "updated", direction: "asc", since, per_page: "100" });
  let url: string | null = `${githubApi}/repos/${repo}/issues?${query.toString()}`;
  let last = since;
  let etag: string | null = null;
  const drafts: ItemDraft[] = [];
  for (let page = 0; url !== null && page < maxPages; page += 1) {
    let answer;
    try {
      answer = await get(url, page === 0 ? fetchState.etag : undefined);
    } catch (error) {
      if (error instanceof GithubHttpError && error.status === 404) {
        throw new Error(`GitHub has no repo ${repo} that the token can read. It may have been renamed, deleted or made private.`, { cause: error });
      }
      throw error;
    }
    if ("deferUntil" in answer) return answer;
    if (answer.status === 304) {
      await answer.body?.cancel();
      return { notModified: true };
    }
    if (page === 0) etag = answer.headers.get("etag");
    for (const entry of z.array(issue).parse(await answer.json())) {
      last = entry.updated_at;
      // The issues endpoint lists PRs too; a PR reaches Watchdog through a mentions Source.
      if (entry.pull_request === undefined) drafts.push(draft(entry));
    }
    url = nextPage(answer.headers.get("link"));
  }
  return { drafts, fetchState: { since: last, ...(etag !== null && { etag }) } };
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

export { issue };

/** The `Link` header's next page, only when it is on GitHub's API, since the token goes with it. */
function nextPage(link: string | null) {
  const next = /<([^>]+)>;\s*rel="next"/.exec(link ?? "")?.[1];
  return next !== undefined && URL.parse(next)?.origin === githubApi ? next : null;
}
