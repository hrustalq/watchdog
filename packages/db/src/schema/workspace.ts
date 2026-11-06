import { sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, text, time, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";

/**
 * The Workspace owns everything else. In the MVP it has exactly one user, its owner, and the
 * unique owner_user_id enforces that. Team membership can come later as its own table without
 * changing who owns the Workspace.
 *
 * Its alert settings are columns here, not a table of their own, so every Workspace has them and
 * the defaults are the database's (docs: Actions and delivery, "Grouping and rate limits").
 */
export const workspace = pgTable(
  "workspace",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: "cascade" }),
    /**
     * An IANA name. Quiet hours, Digest schedules and the hosted email cap's day use it. Postgres
     * can't check it (a check can't read pg_timezone_names), so the Settings screen validates with
     * Intl.supportedValuesOf("timeZone") before writing.
     */
    timezone: text("timezone").notNull().default("UTC"),
    /** Local times in the Workspace timezone. Both null when quiet hours are off. */
    quietHoursStart: time("quiet_hours_start"),
    quietHoursEnd: time("quiet_hours_end"),
    severity5BypassesQuietHours: boolean("severity_5_bypasses_quiet_hours").notNull().default(false),
    alertsPerHour: integer("alerts_per_hour").notNull().default(20),
    burstWindowSeconds: integer("burst_window_seconds").notNull().default(60),
    /** The end of the local day whose hosted email cap notice has gone, so there's one a day. */
    emailCapNoticeUntil: timestamp("email_cap_notice_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check(
      "workspace_quiet_hours_check",
      sql`(${table.quietHoursStart} is null) = (${table.quietHoursEnd} is null)`,
    ),
    // At 0 every alert would be over the limit and held for good.
    check("workspace_alerts_per_hour_check", sql`${table.alertsPerHour} > 0`),
    check("workspace_burst_window_seconds_check", sql`${table.burstWindowSeconds} >= 0`),
  ],
);
