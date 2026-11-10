import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { source } from "./source.ts";
import { workspace } from "./workspace.ts";

/**
 * A delivery target an Action points at: a Telegram chat, an email address or a webhook URL
 * (docs: Actions and delivery, "Destinations").
 */
export const destination = pgTable(
  "destination",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /** A text column with a check, not a Postgres enum, for the reason on source.type. */
    type: text("type", { enum: ["telegram", "email", "webhook"] }).notNull(),
    /** What an Action's `destinations` list names. */
    name: text("name").notNull(),
    /** The non-secret settings: the email address, the webhook URL. */
    config: jsonb("config").notNull().default({}),
    /**
     * The webhook secret, or the Telegram chat binding, encrypted with encryptSecret from
     * packages/core. Null until there is one.
     */
    secretCiphertext: text("secret_ciphertext"),
    /** When a webhook secret was shown. Null until then, and it is shown only while this is null. */
    secretShownAt: timestamp("secret_shown_at", { withTimezone: true }),
    /** Null for an unconfirmed email address or an unlinked Telegram chat. */
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check("destination_type_check", sql`${table.type} in ('telegram', 'email', 'webhook')`),
    unique("destination_workspace_id_name_key").on(table.workspaceId, table.name),
    // Lets health_alert_destination reference (workspace_id, id), so a Workspace can only name its
    // own Destinations.
    unique("destination_workspace_id_id_key").on(table.workspaceId, table.id),
  ],
);

/**
 * The link that confirms an email Destination (docs: Security and privacy, "Destinations"). Only the
 * SHA-256 hash is stored, as for the setup token. A Destination has one live link: sending it again
 * replaces this row, and using it deletes the row.
 */
export const destinationConfirmation = pgTable("destination_confirmation", {
  tokenHash: text("token_hash").primaryKey(),
  destinationId: uuid("destination_id")
    .notNull()
    .unique()
    .references(() => destination.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/**
 * A code from a Telegram deep link, waiting for the bot to be sent `/start <code>` (ADR 0029). It links
 * a chat to a Destination, or binds one to a Telegram bot Source (docs: Sources and ingestion, "Telegram
 * bot intake"). Only the SHA-256 hash is stored, as for the setup token. A used code is deleted.
 */
export const telegramLinkCode = pgTable(
  "telegram_link_code",
  {
    codeHash: text("code_hash").primaryKey(),
    destinationId: uuid("destination_id").references(() => destination.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").references(() => source.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [check("telegram_link_code_target_check", sql`num_nonnulls(${table.destinationId}, ${table.sourceId}) = 1`)],
);

/**
 * The Workspace's Health alerts setting: the Destinations that Source failing and Source recovered
 * alerts go to (docs: Actions and delivery, "Source Health alerts"). None means the sign-in address.
 * A deleted Destination leaves the setting; refusing to delete the only one is the screen's job.
 */
export const healthAlertDestination = pgTable(
  "health_alert_destination",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    destinationId: uuid("destination_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.destinationId] }),
    foreignKey({
      name: "health_alert_destination_destination_fk",
      columns: [table.workspaceId, table.destinationId],
      foreignColumns: [destination.workspaceId, destination.id],
    }).onDelete("cascade"),
    index("health_alert_destination_destination_id_idx").on(table.destinationId),
  ],
);

/**
 * One Source failing or Source recovered alert to one recipient (docs: Actions and delivery, "Source
 * Health alerts"). Not a Delivery, which needs an Action and an Item. A null Destination is the
 * address the Workspace's user signs in with.
 */
export const sourceAlert = pgTable(
  "source_alert",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => source.id, { onDelete: "cascade" }),
    /** An alert still waiting for a removed Destination goes with it, unsent. */
    destinationId: uuid("destination_id").references(() => destination.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["failing", "recovered"] }).notNull(),
    /** The Source's last error when it became failing, which a later success clears from the Source. */
    error: text("error"),
    /**
     * A new alert is held and due at once, so the worker's sweep queues its job. Whatever changes a
     * Source's Health can then write one without a queue of its own.
     */
    status: text("status", { enum: ["queued", "held", "sent", "failed"] })
      .notNull()
      .default("held"),
    attempts: integer("attempts").notNull().default(0),
    /** When a held alert goes, or a failed attempt is retried. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow(),
    /** When a hold ended, from which its 24 hours of retries run. Without a hold, from created_at. */
    retryFrom: timestamp("retry_from", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("source_alert_kind_check", sql`${table.kind} in ('failing', 'recovered')`),
    check("source_alert_status_check", sql`${table.status} in ('queued', 'held', 'sent', 'failed')`),
    // The worker's sweep, every minute.
    index("source_alert_held_next_attempt_at_idx").on(table.nextAttemptAt).where(sql`${table.status} = 'held'`),
    // The cascades when a Source or a Destination is deleted.
    index("source_alert_source_id_idx").on(table.sourceId),
    index("source_alert_destination_id_idx").on(table.destinationId),
  ],
);
