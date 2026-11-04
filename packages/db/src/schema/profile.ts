import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspace } from "./workspace.ts";

/** Who the user is and what they track, in their own words. Every Agent call gets it as context. */
export const profile = pgTable("profile", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspace.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  /** The language of the Agent's summaries and rating reasoning. */
  outputLanguage: text("output_language").notNull().default("en"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
