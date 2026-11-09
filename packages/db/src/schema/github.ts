import { sql } from "drizzle-orm";
import { check, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * GitHub's rate limits per token and per API resource (`core` or `search`), so every worker sees
 * them (docs: Sources and ingestion, "Rate limits"). The token is only ever its SHA-256 hash, so
 * Sources that share a token share its limits without it being readable.
 */
export const githubRateLimit = pgTable(
  "github_rate_limit",
  {
    tokenHash: text("token_hash").notNull(),
    resource: text("resource", { enum: ["core", "search"] }).notNull(),
    /**
     * When the token's requests may start again, after an answer with no requests remaining (just
     * past its `x-ratelimit-reset`) or with a `retry-after`. Null, or past, when they may now.
     */
    pausedUntil: timestamp("paused_until", { withTimezone: true }),
    /**
     * The minute the token's Search calls are being counted in, and how many it has made, so its
     * mentions Sources together stay inside the 30 a minute GitHub allows.
     */
    windowStart: timestamp("window_start", { withTimezone: true }),
    windowCalls: integer("window_calls").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.tokenHash, table.resource] }),
    check("github_rate_limit_resource_check", sql`${table.resource} in ('core', 'search')`),
  ],
);
