// The GitHub Source type. So far it reads releases, through the repo's public releases.atom and
// the RSS parser, with no API call and no token (docs: Sources and ingestion, "GitHub").
import { z } from "zod";
import { FeedHttpError, fetchFeed, type FetchFeedDeps, type FetchState } from "../rss/fetch-feed.ts";
import type { SourceTypeImpl } from "../types.ts";

const owner = /^[a-z\d][a-z\d-]{0,38}$/i;
const name = /^[\w.-]{1,100}$/;

/**
 * `owner/repo` from what the user typed: the pair itself, or a github.com URL to the repo or to
 * any page in it. Null when it can't be a GitHub repo.
 */
export function parseRepo(input: string) {
  const path = input.trim().replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "");
  const [user = "", repo = ""] = path.split(/[/?#]/);
  const bare = repo.replace(/\.git$/i, "");
  const valid = owner.test(user) && name.test(bare) && bare !== "." && bare !== "..";
  return valid ? `${user}/${bare}` : null;
}

export const releasesFeedUrl = (repo: string) => `https://github.com/${repo}/releases.atom`;

const config = z.object({ kind: z.literal("releases"), repo: z.string() });

/** Fetches the repo's releases feed. Throws MissingRepoError when GitHub has no such public repo. */
export async function fetchReleases(repo: string, fetchState: FetchState, deps: FetchFeedDeps) {
  try {
    return await fetchFeed(releasesFeedUrl(repo), fetchState, deps);
  } catch (error) {
    // GitHub answers 404 alike for a repo that doesn't exist and one the visitor can't see.
    if (error instanceof FeedHttpError && error.status === 404) throw new MissingRepoError(repo);
    throw error;
  }
}

export const github: SourceTypeImpl = {
  config,
  backfill: { window: 7 * 24 * 60 * 60 * 1000, max: 50 },
  poll: async (source, deps) => {
    const parsed = config.safeParse(source.config);
    if (!parsed.success) throw new Error("The Source's config isn't a GitHub repo's releases");
    const fetched = await fetchReleases(parsed.data.repo, source.fetchState, deps);
    if ("notModified" in fetched) return fetched;
    return { drafts: fetched.entries, fetchState: { ...fetched.fetchState } };
  },
};

/** GitHub has no public repo by that name. */
export class MissingRepoError extends Error {
  override name = "MissingRepoError";
  constructor(repo: string) {
    super(`GitHub has no public repo ${repo}. It may have been renamed, deleted or made private.`);
  }
}
