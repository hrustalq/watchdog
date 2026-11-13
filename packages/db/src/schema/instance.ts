import { sql } from "drizzle-orm";
import { boolean, check, pgTable, text } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";

/**
 * Settings for the whole install, in a single row (id is always true). Self-hosted keeps the first-run
 * admin claim and whether people may sign up on their own here; both modes keep the encryption key's
 * fingerprint the worker writes at boot.
 */
export const instanceSettings = pgTable(
  "instance_settings",
  {
    id: boolean("id").primaryKey().default(true),
    /** The instance admin. Null until someone claims the install with the setup URL. */
    adminUserId: text("admin_user_id").references(() => user.id, { onDelete: "set null" }),
    /** The email given on the setup page, which may sign up and becomes admin on first sign-in. */
    claimedEmail: text("claimed_email"),
    /** A SHA-256 hash of the token in the setup URL, never the token itself. */
    setupTokenHash: text("setup_token_hash"),
    /** Whether an email Watchdog hasn't seen may sign up. Closed until the admin opens it. */
    signupOpen: boolean("signup_open").notNull().default(false),
    /**
     * The worker's `keyFingerprint` of WATCHDOG_ENCRYPTION_KEY, an HMAC that can't be turned back into
     * the key. Web compares its own, so a service recreated with another value shows on the Model
     * screen. Null until a worker of this version boots.
     */
    encryptionKeyFingerprint: text("encryption_key_fingerprint"),
  },
  (table) => [check("instance_settings_single_row", sql`${table.id}`)],
);
