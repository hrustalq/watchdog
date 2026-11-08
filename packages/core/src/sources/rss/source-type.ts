// The RSS/Atom Source type: a feed polled on its schedule (docs: Sources and ingestion, "RSS/Atom").
import { z } from "zod";
import type { SourceTypeImpl } from "../types.ts";
import { fetchFeed } from "./fetch-feed.ts";

const config = z.object({ url: z.url() });

export const rss: SourceTypeImpl = {
  config,
  backfill: { window: 7 * 24 * 60 * 60 * 1000, max: 50 },
  poll: async (source, deps) => {
    const fetched = await fetchFeed(config.parse(source.config).url, source.fetchState, deps);
    return "notModified" in fetched ? fetched : { drafts: fetched.entries, fetchState: fetched.fetchState };
  },
};
