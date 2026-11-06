import { relations } from "drizzle-orm";
import { action, actionDestination, delivery, digestItem } from "./action.ts";
import { agentCall, modelConfig } from "./agent.ts";
import { correction } from "./correction.ts";
import { destination } from "./destination.ts";
import { item, itemLog } from "./item.ts";
import { profile } from "./profile.ts";
import { classifier, extractorRule, itemCategory, itemField } from "./rule.ts";
import { source } from "./source.ts";
import { workspace } from "./workspace.ts";

// For relational queries (db.query.*). They add no constraints; the foreign keys live on the tables.

export const workspaceRelations = relations(workspace, ({ one, many }) => ({
  sources: many(source),
  items: many(item),
  classifiers: many(classifier),
  extractorRules: many(extractorRule),
  actions: many(action),
  destinations: many(destination),
  corrections: many(correction),
  profile: one(profile),
  modelConfigs: many(modelConfig),
}));

export const sourceRelations = relations(source, ({ one, many }) => ({
  workspace: one(workspace, { fields: [source.workspaceId], references: [workspace.id] }),
  items: many(item),
}));

export const itemRelations = relations(item, ({ one, many }) => ({
  workspace: one(workspace, { fields: [item.workspaceId], references: [workspace.id] }),
  source: one(source, { fields: [item.sourceId], references: [source.id] }),
  log: many(itemLog),
  categories: many(itemCategory),
  fields: many(itemField),
  deliveries: many(delivery),
  digestItems: many(digestItem),
}));

export const itemLogRelations = relations(itemLog, ({ one }) => ({
  item: one(item, { fields: [itemLog.itemId], references: [item.id] }),
}));

export const classifierRelations = relations(classifier, ({ one }) => ({
  workspace: one(workspace, { fields: [classifier.workspaceId], references: [workspace.id] }),
}));

export const extractorRuleRelations = relations(extractorRule, ({ one }) => ({
  workspace: one(workspace, { fields: [extractorRule.workspaceId], references: [workspace.id] }),
}));

export const itemCategoryRelations = relations(itemCategory, ({ one }) => ({
  item: one(item, { fields: [itemCategory.itemId], references: [item.id] }),
  classifier: one(classifier, { fields: [itemCategory.classifierId], references: [classifier.id] }),
}));

export const itemFieldRelations = relations(itemField, ({ one }) => ({
  item: one(item, { fields: [itemField.itemId], references: [item.id] }),
  extractorRule: one(extractorRule, { fields: [itemField.extractorRuleId], references: [extractorRule.id] }),
}));

export const destinationRelations = relations(destination, ({ one, many }) => ({
  workspace: one(workspace, { fields: [destination.workspaceId], references: [workspace.id] }),
  actionDestinations: many(actionDestination),
  deliveries: many(delivery),
}));

export const actionRelations = relations(action, ({ one, many }) => ({
  workspace: one(workspace, { fields: [action.workspaceId], references: [workspace.id] }),
  actionDestinations: many(actionDestination),
  deliveries: many(delivery),
  digestItems: many(digestItem),
}));

export const actionDestinationRelations = relations(actionDestination, ({ one }) => ({
  action: one(action, { fields: [actionDestination.actionId], references: [action.id] }),
  destination: one(destination, { fields: [actionDestination.destinationId], references: [destination.id] }),
}));

export const deliveryRelations = relations(delivery, ({ one }) => ({
  action: one(action, { fields: [delivery.actionId], references: [action.id] }),
  item: one(item, { fields: [delivery.itemId], references: [item.id] }),
  destination: one(destination, { fields: [delivery.destinationId], references: [destination.id] }),
}));

export const digestItemRelations = relations(digestItem, ({ one }) => ({
  action: one(action, { fields: [digestItem.actionId], references: [action.id] }),
  item: one(item, { fields: [digestItem.itemId], references: [item.id] }),
}));

export const correctionRelations = relations(correction, ({ one }) => ({
  workspace: one(workspace, { fields: [correction.workspaceId], references: [workspace.id] }),
}));

export const profileRelations = relations(profile, ({ one }) => ({
  workspace: one(workspace, { fields: [profile.workspaceId], references: [workspace.id] }),
}));

export const modelConfigRelations = relations(modelConfig, ({ one, many }) => ({
  workspace: one(workspace, { fields: [modelConfig.workspaceId], references: [workspace.id] }),
  agentCalls: many(agentCall),
}));

export const agentCallRelations = relations(agentCall, ({ one }) => ({
  modelConfig: one(modelConfig, { fields: [agentCall.modelConfigId], references: [modelConfig.id] }),
}));
