import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { item } from "./item.ts";
import { workspace } from "./workspace.ts";

/**
 * A model a Workspace brought. A replaced model is archived, never deleted, so Usage history keeps
 * pointing at what ran (docs: Agent and LLM integration).
 */
export const modelConfig = pgTable(
  "model_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    providerType: text("provider_type", { enum: ["openai-compatible", "anthropic", "google"] }).notNull(),
    baseUrl: text("base_url").notNull(),
    modelName: text("model_name").notNull(),
    /** Null when the model needs no key, as a local one may not. */
    apiKeyCiphertext: text("api_key_ciphertext"),
    /** Without it, the Agent asks for plain JSON and relies on validation. */
    supportsStructuredOutput: boolean("supports_structured_output").notNull().default(false),
    /** Prices the user entered, for the Usage screen's estimated cost. */
    inputPricePerMillion: numeric("input_price_per_million", { mode: "number" }),
    outputPricePerMillion: numeric("output_price_per_million", { mode: "number" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check(
      "model_config_provider_type_check",
      sql`${table.providerType} in ('openai-compatible', 'anthropic', 'google')`,
    ),
    // A Workspace has one active model.
    uniqueIndex("model_config_workspace_id_active_key")
      .on(table.workspaceId)
      .where(sql`${table.archivedAt} is null`),
  ],
);

/** One attempt at one Agent call, metered whether or not it worked (ADR 0008). */
export const agentCall = pgTable(
  "agent_call",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /** No delete action: a model with calls is archived, and only its Workspace can remove it. */
    modelConfigId: uuid("model_config_id")
      .notNull()
      .references(() => modelConfig.id),
    itemId: uuid("item_id").references(() => item.id, { onDelete: "set null" }),
    purpose: text("purpose", { enum: ["classify", "extract-rate", "compile-rule", "draft-profile"] }).notNull(),
    attempt: integer("attempt").notNull(),
    /** Null when the provider reports no usage. */
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    latencyMs: integer("latency_ms").notNull(),
    status: text("status", { enum: ["ok", "invalid_output", "error"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "agent_call_purpose_check",
      sql`${table.purpose} in ('classify', 'extract-rate', 'compile-rule', 'draft-profile')`,
    ),
    check("agent_call_status_check", sql`${table.status} in ('ok', 'invalid_output', 'error')`),
    index("agent_call_workspace_id_created_at_idx").on(table.workspaceId, table.createdAt),
    // Deleting an Item sets item_id null here. Without this, deleting a Source with many Items scans
    // the whole table once per Item.
    index("agent_call_item_id_idx").on(table.itemId),
  ],
);
