import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workspace } from "./workspace.ts";

/** Each Source type's `config` (docs: Sources and ingestion, "Source types"). */
export interface SourceConfigs {
  rss: { url: string };
  github:
    | { kind: "releases" | "issues"; repo: string }
    | { kind: "mentions"; term: string; within?: string };
  website: { url: string; region?: string; ignore: string[]; render: "static" | "obscura" | "chromium" };
  /** Optional JSONPaths that turn a payload into an Item. */
  webhook: { mapping?: { title?: string; body?: string; url?: string; externalId?: string } };
  /** A bot Source has no chat until the bot binds one. */
  telegram: { via: "bot" | "session"; chatId?: number; title?: string };
}
export type SourceType = keyof SourceConfigs;

const sourceTypes = ["rss", "github", "website", "webhook", "telegram"] as const satisfies SourceType[];

/** The types with a Schedule Trigger, the only ones polled. source_schedule_check lists them too. */
export const scheduleTypes = ["rss", "github", "website"] as const satisfies SourceType[];

/** A place a Workspace watches for new Items. */
export const source = pgTable(
  "source",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /**
     * A text column with a check, not a Postgres enum: widening the check works inside the one
     * transaction Drizzle's migrator runs, where a new enum value can't be used until it commits.
     */
    type: text("type", { enum: sourceTypes }).notNull(),
    name: text("name").notNull(),
    /** The type's settings, as SourceConfigs has them. */
    config: jsonb("config").$type<SourceConfigs[SourceType]>().notNull(),
    /**
     * What makes two Sources the same Source, built from config by Postgres so no writer can get it
     * wrong (docs: Sources and ingestion, "Uniqueness"). Null for an inbox and an unbound bot Source,
     * which the unique index ignores.
     */
    dedupKey: text("dedup_key").generatedAlwaysAs(sql`case "type"
      when 'rss' then "config"->>'url'
      when 'github' then case "config"->>'kind'
        when 'mentions' then 'mentions:' || coalesce("config"->>'within', '') || ':' || btrim("config"->>'term')
        else lower(("config"->>'kind') || ':' || ("config"->>'repo')) end
      when 'website' then ("config"->>'url') || ' ' || btrim(coalesce("config"->>'region', ''))
      when 'telegram' then "config"->>'chatId'
    end`),
    /** The Schedule Trigger's cron expression. Only Schedule types have one. */
    schedule: text("schedule"),
    /**
     * When the Schedule tick next enqueues a poll. A new Schedule Source is due at once; any other
     * type must insert null.
     */
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }).defaultNow(),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    /** Source Health (docs: Sources and ingestion, "Source Health"). */
    health: text("health", { enum: ["ok", "degraded", "failing"] }).notNull().default("ok"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    /**
     * A pasted GitHub token, or an Inbox token until the Source page has shown it, encrypted with
     * encryptSecret from packages/core (docs: Security and privacy, "Source credentials").
     */
    secretCiphertext: text("secret_ciphertext"),
    /** The SHA-256 hash of a webhook Source's Inbox token, which inbox requests are looked up by. */
    inboxTokenHash: text("inbox_token_hash").unique("source_inbox_token_hash_key"),
    /** Conditional-request state from the last fetch, such as ETag and Last-Modified. */
    fetchState: jsonb("fetch_state").$type<Record<string, string>>().notNull().default({}),
    /** When the first successful fetch took the Backfill. Null until then. */
    backfilledAt: timestamp("backfilled_at", { withTimezone: true }),
    /**
     * IDs of the entries the Backfill fetch saw but didn't capture: undated, too old, or beyond the
     * cap of 50. Later polls never capture them (docs: Processing pipeline, "Stages"). Null until
     * the Backfill.
     */
    backfillSkippedIds: text("backfill_skipped_ids").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check("source_type_check", sql`${table.type} in ('rss', 'github', 'website', 'webhook', 'telegram')`),
    // Schedule types poll, so they need both; the rest never poll, so the tick must not find them.
    // The list is scheduleTypes.
    check(
      "source_schedule_check",
      sql`case when ${table.type} in ('rss', 'github', 'website')
        then ${table.schedule} is not null and ${table.nextPollAt} is not null
        else ${table.schedule} is null and ${table.nextPollAt} is null end`,
    ),
    check("source_health_check", sql`${table.health} in ('ok', 'degraded', 'failing')`),
    check("source_consecutive_failures_check", sql`${table.consecutiveFailures} >= 0`),
    index("source_next_poll_at_idx").on(table.nextPollAt),
    // Lists a Workspace's Sources, and lets item reference (workspace_id, id) so an Item's
    // denormalised workspace_id can only be its Source's.
    unique("source_workspace_id_id_key").on(table.workspaceId, table.id),
    // A Workspace watches a Source once; another Workspace can watch the same one. The key is
    // hashed, since a btree entry can't hold a very long URL.
    uniqueIndex("source_workspace_id_type_dedup_key_key").on(
      table.workspaceId,
      table.type,
      sql`md5(${table.dedupKey})`,
    ),
  ],
);
