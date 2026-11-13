import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { destination } from "./destination.ts";
import { item } from "./item.ts";
import { ruleColumns } from "./rule.ts";
import { workspace } from "./workspace.ts";

/**
 * The third type of rule: what happens outside the Feed when an Item meets a Condition (docs:
 * Rule model, "Actions"). `definition` holds the canonical model with its Destinations by id (the
 * YAML shows their names, and renaming one changes nothing here); action_destination keeps the same
 * set as foreign keys, so a Destination an Action points at can't be deleted.
 *
 * The two foreign keys to destination (here and on delivery) are DEFERRABLE INITIALLY DEFERRED,
 * written by hand in migration 0009 because Drizzle can't declare it. Postgres checks a plain
 * NO ACTION key when the statement that deleted the row ends, and a Workspace's cascade deletes
 * its Destinations in a statement of its own before it reaches its Actions, so deleting a user
 * would fail on a Destination its own Action still points at. Deferred, the check runs at commit,
 * when the Actions are gone too. A Destination deleted on its own is still refused, at commit.
 */
export const action = pgTable(
  "action",
  {
    ...ruleColumns,
    kind: text("kind", { enum: ["alert", "webhook", "digest"] }).notNull(),
    /**
     * When a Digest's schedule last ran, sent or not. Its next send is the schedule's first time after
     * this or `updated_at`, whichever is later, so a save or a new timezone takes effect at once.
     */
    digestRanAt: timestamp("digest_ran_at", { withTimezone: true }),
  },
  (table) => [
    check("action_kind_check", sql`${table.kind} in ('alert', 'webhook', 'digest')`),
    unique("action_workspace_id_name_key").on(table.workspaceId, table.name),
  ],
);

/** The Destinations an Action points at. */
export const actionDestination = pgTable(
  "action_destination",
  {
    actionId: uuid("action_id")
      .notNull()
      .references(() => action.id, { onDelete: "cascade" }),
    destinationId: uuid("destination_id")
      .notNull()
      .references(() => destination.id),
  },
  (table) => [
    primaryKey({ columns: [table.actionId, table.destinationId] }),
    // Deleting a Destination checks this foreign key, and the Destinations screen lists the Actions
    // that point at one.
    index("action_destination_destination_id_idx").on(table.destinationId),
  ],
);

/**
 * One alert or webhook Action's message to one Destination for one Item (docs: Actions and
 * delivery, "Deliveries"). The unique key is "fires once per Item and Destination" (ADR 0028).
 */
export const delivery = pgTable(
  "delivery",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actionId: uuid("action_id")
      .notNull()
      .references(() => action.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => item.id, { onDelete: "cascade" }),
    /** No delete action: a Destination with Deliveries can't be deleted. */
    destinationId: uuid("destination_id")
      .notNull()
      .references(() => destination.id),
    status: text("status", { enum: ["queued", "held", "grouped", "sent", "failed"] })
      .notNull()
      .default("queued"),
    attempts: integer("attempts").notNull().default(0),
    /** When a held or grouped Delivery goes, or a failed attempt is retried. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    /**
     * Why it waits, while it's held or grouped (docs: Actions and delivery, "Deliveries"). A Settings save
     * that changes a setting makes the rows it held due again, and reads this to leave the email cap's
     * alone, because the cap isn't a setting and a release would only hold the row again.
     */
    holdReason: text("hold_reason", { enum: ["quiet-hours", "rate-limit", "burst-window", "email-cap"] }),
    /** When a hold ended, from which its 24 hours of retries run. Without a hold, they run from created_at. */
    retryFrom: timestamp("retry_from", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("delivery_status_check", sql`${table.status} in ('queued', 'held', 'grouped', 'sent', 'failed')`),
    check(
      "delivery_hold_reason_check",
      sql`${table.holdReason} is null or ${table.holdReason} in ('quiet-hours', 'rate-limit', 'burst-window', 'email-cap')`,
    ),
    unique("delivery_action_id_item_id_destination_id_key").on(table.actionId, table.itemId, table.destinationId),
    // The queue: what is due to a Destination and when, for grouping.
    index("delivery_destination_id_status_next_attempt_at_idx").on(
      table.destinationId,
      table.status,
      table.nextAttemptAt,
    ),
    // The worker's sweep, which runs every minute over every Destination's few waiting rows.
    index("delivery_waiting_next_attempt_at_idx")
      .on(table.nextAttemptAt)
      .where(sql`${table.status} in ('held', 'grouped')`),
    // The Log's view of an Item, and the cascade when the Item is deleted.
    index("delivery_item_id_idx").on(table.itemId),
  ],
);

/**
 * One Telegram message or mail that went out, which the rate limit and the hosted email cap count (ADR
 * 0030). Apart from `delivery`, whose rows go with their Action, Item or Destination, because deleting and
 * making one again mustn't reset a count. A Grouped alert is one row. A webhook isn't counted.
 */
export const sentMessage = pgTable(
  "sent_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /** Null once the Destination is deleted: its rate limit goes with it, and the Workspace's cap doesn't. */
    destinationId: uuid("destination_id").references(() => destination.id, { onDelete: "set null" }),
    type: text("type", { enum: ["telegram", "email"] }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check("sent_message_type_check", sql`${table.type} in ('telegram', 'email')`),
    index("sent_message_workspace_id_sent_at_idx").on(table.workspaceId, table.sentAt),
    index("sent_message_destination_id_sent_at_idx").on(table.destinationId, table.sentAt),
    // The worker's sweep forgets old rows across every Workspace.
    index("sent_message_sent_at_idx").on(table.sentAt),
  ],
);

/** The Items a Digest has collected and not yet sent. The Digest's send deletes the rows it sent. */
export const digestItem = pgTable(
  "digest_item",
  {
    actionId: uuid("action_id")
      .notNull()
      .references(() => action.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => item.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.actionId, table.itemId] }),
    // As on delivery.
    index("digest_item_item_id_idx").on(table.itemId),
  ],
);
