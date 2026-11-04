import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
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
    // Lets agent_call reference (workspace_id, id).
    unique("model_config_workspace_id_id_key").on(table.workspaceId, table.id),
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
    modelConfigId: uuid("model_config_id").notNull(),
    itemId: uuid("item_id").references(() => item.id, { onDelete: "set null" }),
    purpose: text("purpose", {
      enum: ["classify", "extract-rate", "compile-rule", "draft-profile", "test-connection"],
    }).notNull(),
    attempt: integer("attempt").notNull(),
    /** Null when the provider reports no usage. */
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    latencyMs: integer("latency_ms").notNull(),
    status: text("status", { enum: ["ok", "invalid_output", "error"] }).notNull(),
    /** Why the attempt failed, for the Model screen, with the API key redacted. Null when it worked. */
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Keeps workspace_id equal to the model's Workspace. No delete action: a model with calls is
    // archived, and only its Workspace can remove it.
    foreignKey({
      name: "agent_call_model_config_fk",
      columns: [table.workspaceId, table.modelConfigId],
      foreignColumns: [modelConfig.workspaceId, modelConfig.id],
    }),
    check(
      "agent_call_purpose_check",
      sql`${table.purpose} in ('classify', 'extract-rate', 'compile-rule', 'draft-profile', 'test-connection')`,
    ),
    check("agent_call_status_check", sql`${table.status} in ('ok', 'invalid_output', 'error')`),
    index("agent_call_workspace_id_created_at_idx").on(table.workspaceId, table.createdAt),
    // Deleting an Item sets item_id null here. Without this, deleting a Source with many Items scans
    // the whole table once per Item.
    index("agent_call_item_id_idx").on(table.itemId),
  ],
);
