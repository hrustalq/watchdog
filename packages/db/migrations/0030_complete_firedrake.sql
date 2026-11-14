ALTER TABLE "workspace" ADD COLUMN "items_retention_days" integer DEFAULT 90;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "log_retention_days" integer DEFAULT 30;--> statement-breakpoint
-- Every Workspace that existed before this migration kept everything, so it starts on the documented
-- defaults rather than on unlimited. A null would silently turn retention off for it.
UPDATE "workspace" SET "items_retention_days" = 90, "log_retention_days" = 30
  WHERE "items_retention_days" IS NULL OR "log_retention_days" IS NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_items_retention_days_check" CHECK ("workspace"."items_retention_days" is null or "workspace"."items_retention_days" >= 1);--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_log_retention_days_check" CHECK ("workspace"."log_retention_days" is null or "workspace"."log_retention_days" >= 1);
