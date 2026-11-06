import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { item } from "./item.ts";
import { workspace } from "./workspace.ts";

/**
 * What every rule shares (an Action in action.ts overrides `kind`). `definition` holds the
 * canonical rule model, whose zod schemas live in packages/core. This package doesn't depend on
 * core (ADR 0024), so callers parse the column.
 */
export const ruleColumns = {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspace.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["deterministic", "agent"] }).notNull(),
  definition: jsonb("definition").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** From the database's clock, because the pipeline compares it with an Item's captured_at. */
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => sql`now()`),
};

/** Sorts Items into Categories. */
export const classifier = pgTable("classifier", ruleColumns, (table) => [
  check("classifier_kind_check", sql`${table.kind} in ('deterministic', 'agent')`),
  unique("classifier_workspace_id_name_key").on(table.workspaceId, table.name),
]);

/** Pulls structured fields out of an Item. */
export const extractorRule = pgTable("extractor_rule", ruleColumns, (table) => [
  check("extractor_rule_kind_check", sql`${table.kind} in ('deterministic', 'agent')`),
  unique("extractor_rule_workspace_id_name_key").on(table.workspaceId, table.name),
]);

/** A Category on an Item. It stays when its Classifier is deleted. */
export const itemCategory = pgTable(
  "item_category",
  {
    itemId: uuid("item_id")
      .notNull()
      .references(() => item.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    classifierId: uuid("classifier_id").references(() => classifier.id, { onDelete: "set null" }),
  },
  (table) => [
    primaryKey({ columns: [table.itemId, table.category] }),
    // Deleting a Classifier sets classifier_id null here. Without this, that scans every Workspace's
    // rows.
    index("item_category_classifier_id_idx").on(table.classifierId),
  ],
);

/** A field extracted from an Item. It stays when its Extractor Rule is deleted. */
export const itemField = pgTable(
  "item_field",
  {
    itemId: uuid("item_id")
      .notNull()
      .references(() => item.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    value: jsonb("value").notNull(),
    extractorRuleId: uuid("extractor_rule_id").references(() => extractorRule.id, { onDelete: "set null" }),
  },
  (table) => [
    primaryKey({ columns: [table.itemId, table.name] }),
    // As on item_category.
    index("item_field_extractor_rule_id_idx").on(table.extractorRuleId),
  ],
);
