// What every Source type implements, so capture is written once for all of them (docs: Sources and
// ingestion, "Source types"; Processing pipeline, "Capture and the Backfill window").
import type { Db, source, SourceType } from "@watchdog/db";
import type { z } from "zod";
import type { Config } from "../config.ts";
import type { ItemDraft } from "./item.ts";
import type { Deferred, GithubSecrets } from "./github/client.ts";
import { github } from "./github/source-type.ts";
import { rss } from "./rss/source-type.ts";
import type { FetchFeedDeps } from "./rss/fetch-feed.ts";
import { website } from "./website/source-type.ts";

/** A first capture's limits: the newest dated drafts within `window` ms, at most `max` of them. */
export interface Backfill {
  window: number;
  max: number;
}

export interface PollDeps extends FetchFeedDeps {
  /** What decrypts a GitHub Source's token. */
  secrets: GithubSecrets;
  /**
   * Hosted always checks a website's robots.txt; self-hosted lets a Source turn that off. Without
   * it, robots.txt is checked as on hosted.
   */
  mode?: Config["mode"];
}

/**
 * A poll's answer: nothing new since the last poll, the drafts it found, or a poll put off by a
 * rate limit, which isn't a failure.
 */
export type Polled =
  | { notModified: true }
  | { drafts: ItemDraft[]; fetchState: Record<string, string> }
  | Deferred;

/** What a poll reads of its Source. */
export type PolledSource = Pick<
  typeof source.$inferSelect,
  "config" | "fetchState" | "workspaceId" | "secretCiphertext"
>;

export interface SourceTypeImpl {
  /** The shape of the type's `config`. */
  config: z.ZodType;
  /** The Backfill the type's first capture takes, or null when it takes none. */
  backfill: Backfill | null;
  /**
   * Schedule types fetch their Source's new drafts. A push type has no poll: whatever receives its
   * drafts hands them to captureItems. Throws why the fetch failed.
   */
  poll?: (source: PolledSource, deps: PollDeps & { db: Db; now: Date }) => Promise<Polled>;
}

/** The types implemented so far. A Source of any other type polls nothing and takes no Backfill. */
export const sourceTypes: Partial<Record<SourceType, SourceTypeImpl>> = { rss, github, website };
