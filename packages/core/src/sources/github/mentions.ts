// A GitHub mentions Source: issues and PRs matching a term, through the Search API (docs: Sources
// and ingestion, "Mentions").
import { z } from "zod";
import type { Polled } from "../types.ts";
import { type Deferred, githubApi, type GithubResponse } from "./client.ts";
import { draft, issue } from "./issues.ts";
import { owner, parseRepo } from "./releases.ts";

const results = z.object({ items: z.array(issue) });

/** The newest 100 results, each keyed by its URL, since results from different repos share numbers. */
export async function pollMentions(
  { term, within }: { term: string; within?: string | undefined },
  get: (url: string) => Promise<GithubResponse | Deferred>,
): Promise<Polled> {
  const query = new URLSearchParams({
    q: `${term} (is:issue OR is:pr)${within === undefined ? "" : ` ${within}`}`,
    sort: "created",
    order: "desc",
    per_page: "100",
    advanced_search: "true",
  });
  const answer = await get(`${githubApi}/search/issues?${query.toString()}`);
  if ("deferUntil" in answer) return answer;
  const { items } = results.parse(await answer.json());
  const drafts = items.map((entry) => draft(entry, entry.html_url));
  return { drafts, fetchState: {} };
}

/**
 * A search's limit from what the user typed: `repo:<owner>/<name>` for a repo or a URL in it, and
 * `org:<name>` for an owner or its github.com URL. Undefined when nothing was typed, null when it's
 * neither.
 */
export function parseWithin(input: string) {
  const typed = input.trim().replace(/^(?:org|repo):/i, "");
  if (typed === "") return undefined;
  const repo = parseRepo(typed);
  if (repo !== null) return `repo:${repo}`;
  const name = typed.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "").replace(/\/$/, "");
  return owner.test(name) ? `org:${name}` : null;
}
