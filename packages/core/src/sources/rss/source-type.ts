// The RSS/Atom Source type: a feed polled on its schedule (docs: Sources and ingestion, "RSS/Atom").
import { z } from "zod";
import type { SourceTypeImpl } from "../types.ts";
import { fetchFeed } from "./fetch-feed.ts";

const config = z.object({ url: z.string() });

export const rss: SourceTypeImpl = {
  config,
  backfill: { window: 7 * 24 * 60 * 60 * 1000, max: 50 },
  poll: async (source, deps) => {
    const parsed = config.safeParse(source.config);
    if (!parsed.success) throw new Error("The Source's config has no feed URL");
    const fetched = await fetchFeed(parsed.data.url, source.fetchState, deps);
    if ("notModified" in fetched) return fetched;
    // FetchState is an interface, so it lacks the index signature fetch_state has. A copy has one.
    return { drafts: fetched.entries, fetchState: { ...fetched.fetchState } };
  },
};
