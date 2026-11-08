// What every Source type implements, so capture is written once for all of them (docs: Sources and
// ingestion, "Source types"; Processing pipeline, "Capture and the Backfill window").
import type { SourceType } from "@watchdog/db";
import type { z } from "zod";
import type { ItemDraft } from "./item.ts";
import { rss } from "./rss/source-type.ts";
import type { FetchFeedDeps } from "./rss/fetch-feed.ts";

/** A first capture's limits: the newest dated drafts within `window` ms, at most `max` of them. */
export interface Backfill {
  window: number;
  max: number;
}

export type PollDeps = FetchFeedDeps;

/** A poll's answer: nothing new since the last poll, or the drafts it found. */
export type Polled = { notModified: true } | { drafts: ItemDraft[]; fetchState: Record<string, string> };

export interface SourceTypeImpl {
  /** The shape of the type's `config`. */
  config: z.ZodType;
  /** The Backfill the type's first capture takes, or null when it takes none. */
  backfill: Backfill | null;
  /**
   * Schedule types fetch their Source's new drafts. A push type has no poll: whatever receives its
   * drafts hands them to captureItems. Throws why the fetch failed.
   */
  poll?: (source: { config: unknown; fetchState: Record<string, string> }, deps: PollDeps) => Promise<Polled>;
}

/** The types implemented so far. A Source of any other type polls nothing and takes no Backfill. */
export const sourceTypes: Partial<Record<SourceType, SourceTypeImpl>> = { rss };
