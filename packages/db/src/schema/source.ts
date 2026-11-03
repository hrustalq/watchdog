import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { workspace } from "./workspace.ts";

/** A place a Workspace watches for new Items. */
export const source = pgTable(
  "source",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /**
     * RSS/Atom only in M1. A text column with a check, not a Postgres enum: M4 widens the check,
     * which works inside the one transaction Drizzle's migrator runs, where a new enum value can't
     * be used until it commits.
     */
    type: text("type", { enum: ["rss"] }).notNull(),
    name: text("name").notNull(),
    /** The type's settings. RSS: the feed URL. */
    config: jsonb("config").$type<{ url: string }>().notNull(),
    /** The Schedule Trigger's cron expression. */
    schedule: text("schedule").notNull(),
    /** When the Schedule tick next enqueues a poll. A new Source is due at once. */
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }).notNull().defaultNow(),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    /** Conditional-request state from the last fetch, such as ETag and Last-Modified. */
    fetchState: jsonb("fetch_state").$type<Record<string, string>>().notNull().default({}),
    /** When the first successful fetch took the Backfill. Null until then. */
    backfilledAt: timestamp("backfilled_at", { withTimezone: true }),
    /**
     * IDs of the entries the Backfill fetch saw but didn't capture: undated, too old, or beyond the
     * cap of 50. Later polls never capture them (docs: Processing pipeline, "Stages").
     */
    backfillSkippedIds: text("backfill_skipped_ids").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check("source_type_check", sql`${table.type} in ('rss')`),
    index("source_next_poll_at_idx").on(table.nextPollAt),
    // Lists a Workspace's Sources, and lets item reference (workspace_id, id) so an Item's
    // denormalised workspace_id can only be its Source's.
    unique("source_workspace_id_id_key").on(table.workspaceId, table.id),
  ],
);
