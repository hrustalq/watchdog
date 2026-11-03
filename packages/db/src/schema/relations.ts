import { relations } from "drizzle-orm";
import { item, itemLog } from "./item.ts";
import { source } from "./source.ts";
import { workspace } from "./workspace.ts";

// For relational queries (db.query.*). They add no constraints; the foreign keys live on the tables.

export const workspaceRelations = relations(workspace, ({ many }) => ({
  sources: many(source),
  items: many(item),
}));

export const sourceRelations = relations(source, ({ one, many }) => ({
  workspace: one(workspace, { fields: [source.workspaceId], references: [workspace.id] }),
  items: many(item),
}));

export const itemRelations = relations(item, ({ one, many }) => ({
  workspace: one(workspace, { fields: [item.workspaceId], references: [workspace.id] }),
  source: one(source, { fields: [item.sourceId], references: [source.id] }),
  log: many(itemLog),
}));

export const itemLogRelations = relations(itemLog, ({ one }) => ({
  item: one(item, { fields: [itemLog.itemId], references: [item.id] }),
}));
