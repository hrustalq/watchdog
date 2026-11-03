import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  boolean,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { source } from "./source.ts";

/**
 * One thing captured from a Source, in the flat Item envelope every Source type shares
 * (docs: Processing pipeline, "Item envelope").
 */
export const item = pgTable(
  "item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Copied from the Source so the Feed reads one Workspace's Items from one index. The foreign
     * key on (workspace_id, source_id) keeps it equal to the Source's Workspace.
     */
    workspaceId: uuid("workspace_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    /** The Source's own ID for the entry, or its URL when it has none. */
    externalId: text("external_id").notNull(),
    url: text("url"),
    title: text("title"),
    author: text("author"),
    /** Plain text, capped at 32 KB by the parser. */
    body: text("body").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    /** ISO 639-1, or null when the text is too short to tell. */
    language: text("language"),
    isBackfill: boolean("is_backfill").notNull().default(false),
    /** The Source's own payload, for Source-specific extras. */
    raw: jsonb("raw").notNull(),
    /** Written by the Agent from M2. */
    summary: text("summary"),
  },
  (table) => [
    foreignKey({
      name: "item_source_fk",
      columns: [table.workspaceId, table.sourceId],
      foreignColumns: [source.workspaceId, source.id],
    }).onDelete("cascade"),
    // The dedup key: a re-fetch, or two polls racing, can't create a second Item.
    unique("item_source_id_external_id_key").on(table.sourceId, table.externalId),
    // The Feed's Latest order within one Workspace: newest captured first, then newest published
    // (undated last), then id. Every key is non-null and plain desc, so a keyset cursor is one row
    // comparison: (captured_at, coalesce(published_at, '-infinity'), id) < ($1, $2, $3).
    index("item_feed_idx").on(
      table.workspaceId,
      table.capturedAt.desc().nullsFirst(),
      sql`coalesce(${table.publishedAt}, '-infinity') desc`,
      table.id.desc().nullsFirst(),
    ),
  ],
);

/** An Item's Log: one append-only row per thing that happened to it, for the user to read. */
export const itemLog = pgTable(
  "item_log",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => item.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    /** capture in M1. M2 adds classify, extract and rate; M3 adds act (a check, as on source.type). */
    stage: text("stage", { enum: ["capture"] }).notNull(),
    /** The sentence the user reads, such as "Captured from Hacker News". */
    message: text("message").notNull(),
    data: jsonb("data").notNull().default({}),
  },
  (table) => [
    check("item_log_stage_check", sql`${table.stage} in ('capture')`),
    index("item_log_item_id_at_idx").on(table.itemId, table.at),
  ],
);
