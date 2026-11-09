import { sql } from "drizzle-orm";
import { check, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * GitHub's rate limits per token and per API resource (`core` or `search`), as its last answer gave
 * them, so every worker sees them (docs: Sources and ingestion, "Rate limits"). The token is only
 * ever its SHA-256 hash, so Sources that share a token share its limits without it being readable.
 */
export const githubRateLimit = pgTable(
  "github_rate_limit",
  {
    tokenHash: text("token_hash").notNull(),
    resource: text("resource", { enum: ["core", "search"] }).notNull(),
    /** `x-ratelimit-remaining` and `x-ratelimit-reset` from the last answer. */
    remaining: integer("remaining"),
    resetAt: timestamp("reset_at", { withTimezone: true }),
    /** When a `retry-after` from GitHub lets the token's requests start again. */
    retryAt: timestamp("retry_at", { withTimezone: true }),
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
