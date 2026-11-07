import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
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
 * A code from a Telegram deep link, waiting for the bot to be sent `/start <code>` (ADR 0029).
 * Only the SHA-256 hash is stored, as for the setup token. A used code is deleted.
 */
export const telegramLinkCode = pgTable("telegram_link_code", {
  codeHash: text("code_hash").primaryKey(),
  destinationId: uuid("destination_id")
    .notNull()
    .references(() => destination.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
