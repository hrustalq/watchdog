// The GitHub Source type: releases through the public releases.atom, and issues and mentions through
// the API with a token (docs: Sources and ingestion, "GitHub").
import { z } from "zod";
import type { SourceTypeImpl } from "../types.ts";
import { githubGet, githubResource, githubToken } from "./client.ts";
import { pollIssues } from "./issues.ts";
import { pollMentions } from "./mentions.ts";
import { fetchReleases } from "./releases.ts";

const config = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("releases"), repo: z.string() }),
  z.object({ kind: z.literal("issues"), repo: z.string() }),
  z.object({ kind: z.literal("mentions"), term: z.string(), within: z.string().optional() }),
]);

export const github: SourceTypeImpl = {
  config,
  // Releases and issues take 7 days or 50 Items; for mentions that is the search's newest 50.
  backfill: { window: 7 * 24 * 60 * 60 * 1000, max: 50 },
  poll: async (source, deps) => {
    const parsed = config.safeParse(source.config);
    if (!parsed.success) throw new Error("The Source's config isn't a GitHub repo or search");
    const settings = parsed.data;
    if (settings.kind === "releases") {
      const fetched = await fetchReleases(settings.repo, source.fetchState, deps);
      if ("notModified" in fetched) return fetched;
      return { drafts: fetched.entries, fetchState: { ...fetched.fetchState } };
    }
    const token = await githubToken(deps.db, source, deps.secrets);
    const resource = githubResource(settings.kind);
    if (settings.kind === "issues") {
      const get = (url: string, etag?: string) => githubGet(url, { token, resource, etag }, deps);
      return pollIssues(settings.repo, source.fetchState, get, deps.now);
    }
    return pollMentions(settings, (url) => githubGet(url, { token, resource }, deps));
  },
};
