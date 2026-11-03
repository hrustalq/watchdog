import { index, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { workspace } from "./workspace.ts";

/** Source types. M1 has RSS/Atom only; M4 adds more with `alter type … add value`. */
export const sourceType = pgEnum("source_type", ["rss"]);

/** A place a Workspace watches for new Items. */
export const source = pgTable(
  "source",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    type: sourceType("type").notNull(),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("source_next_poll_at_idx").on(table.nextPollAt),
    // Lists a Workspace's Sources, and lets item reference (workspace_id, id) so an Item's
    // denormalised workspace_id can only be its Source's.
    unique("source_workspace_id_id_key").on(table.workspaceId, table.id),
  ],
);
