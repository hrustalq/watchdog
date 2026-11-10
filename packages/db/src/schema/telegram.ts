import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspace } from "./workspace.ts";

/**
 * A Telegram user session login in progress (ADR 0032). The web writes each step the user gives, and
 * the worker's `telegram-login` job, which holds the mtcute client, answers on the row. One a
 * Workspace: starting another replaces it. It lives 5 minutes.
 */
export const telegramLogin = pgTable(
  "telegram_login",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .unique("telegram_login_workspace_id_key")
      .references(() => workspace.id, { onDelete: "cascade" }),
    phone: text("phone").notNull(),
    /**
     * What the login waits for: the worker to ask Telegram for a code, the code, the 2FA password.
     * `failed` ends it, with `refusal` saying why.
     */
    step: text("step", { enum: ["starting", "code", "password", "failed"] }).notNull().default("starting"),
    /** The code and password the user gave, encrypted with encryptSecret, cleared once the worker used them. */
    codeCiphertext: text("code_ciphertext"),
    passwordCiphertext: text("password_ciphertext"),
    /** Telegram's last refusal, as a fixed sentence for the screen, never its raw error text. */
    refusal: text("refusal"),
    /** The job writes it each second. Over 10 seconds old, the worker that held the client is gone. */
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '5 minutes'`),
  },
  (table) => [check("telegram_login_step_check", sql`${table.step} in ('starting', 'code', 'password', 'failed')`)],
);

/** A chat in a session's dialog list. `id` is the marked id the Bot API uses too, such as -100…. */
export interface TelegramDialog {
  id: number;
  title: string;
  type: "group" | "supergroup" | "channel";
}

/** A Workspace's one Telegram user session, self-hosted only (ADR 0014). Only the worker decrypts it. */
export const telegramSession = pgTable("telegram_session", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .unique("telegram_session_workspace_id_key")
    .references(() => workspace.id, { onDelete: "cascade" }),
  /** The account's name and @username, for the screen. */
  account: text("account").notNull(),
  /** mtcute's session string, encrypted with encryptSecret. */
  secretCiphertext: text("secret_ciphertext").notNull(),
  /** Set when the user revokes it. The worker then logs it out on Telegram and deletes the row. */
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  /**
   * The groups, supergroups and channels the account is in, which the runner reads at the start of
   * each turn, for the screen to pick from. Null until it first has.
   */
  dialogs: jsonb("dialogs").$type<TelegramDialog[]>(),
  /** Telegram asked the session to wait past its turn (FLOOD_WAIT), so no turn starts before this. */
  waitUntil: timestamp("wait_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
