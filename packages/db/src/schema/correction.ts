import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { item } from "./item.ts";
import { workspace } from "./workspace.ts";

/**
 * A user's change to an Item's Rating or Categories, shown to the Agent as an example of their
 * judgement. It keeps a copy of the Item's title and summary and outlives the Item, so the Agent can
 * still learn from it after the Item is deleted (docs: Processing pipeline, "Corrections").
 */
export const correction = pgTable(
  "correction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    itemId: uuid("item_id").references(() => item.id, { onDelete: "set null" }),
    kind: text("kind", { enum: ["rating", "categories"] }).notNull(),
    itemTitle: text("item_title"),
    itemSummary: text("item_summary"),
    before: jsonb("before").notNull(),
    after: jsonb("after").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("correction_kind_check", sql`${table.kind} in ('rating', 'categories')`),
    // A second Correction replaces the first, so the Agent never sees two conflicting examples for
    // one Item. Corrections of deleted Items all have a null item_id and must not collide.
    uniqueIndex("correction_item_id_kind_key")
      .on(table.itemId, table.kind)
      .where(sql`${table.itemId} is not null`),
    // The Agent's most recent Corrections: a backward scan serves a plain ORDER BY created_at DESC.
    index("correction_workspace_id_created_at_idx").on(table.workspaceId, table.createdAt),
  ],
);
