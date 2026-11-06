CREATE TABLE "destination" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_ciphertext" text,
	"confirmed_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "destination_workspace_id_name_key" UNIQUE("workspace_id","name"),
	CONSTRAINT "destination_type_check" CHECK ("destination"."type" in ('telegram', 'email', 'webhook'))
);
--> statement-breakpoint
CREATE TABLE "telegram_link_code" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"destination_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "action" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"definition" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_workspace_id_name_key" UNIQUE("workspace_id","name"),
	CONSTRAINT "action_kind_check" CHECK ("action"."kind" in ('alert', 'webhook', 'digest'))
);
--> statement-breakpoint
CREATE TABLE "action_destination" (
	"action_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	CONSTRAINT "action_destination_action_id_destination_id_pk" PRIMARY KEY("action_id","destination_id")
);
--> statement-breakpoint
CREATE TABLE "delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_action_id_item_id_destination_id_key" UNIQUE("action_id","item_id","destination_id"),
	CONSTRAINT "delivery_status_check" CHECK ("delivery"."status" in ('queued', 'held', 'grouped', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "digest_item" (
	"action_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	CONSTRAINT "digest_item_action_id_item_id_pk" PRIMARY KEY("action_id","item_id")
);
--> statement-breakpoint
ALTER TABLE "item_log" DROP CONSTRAINT "item_log_stage_check";--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "timezone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "quiet_hours_start" time;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "quiet_hours_end" time;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "severity_5_bypasses_quiet_hours" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "alerts_per_hour" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "burst_window_seconds" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "destination" ADD CONSTRAINT "destination_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_link_code" ADD CONSTRAINT "telegram_link_code_destination_id_destination_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destination"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action" ADD CONSTRAINT "action_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_destination" ADD CONSTRAINT "action_destination_action_id_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."action"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Deferred by hand (drizzle-kit 0.31 can't write it): a Workspace cascade reaches destination before
-- action, so the check must wait for the end of the transaction. See packages/db/src/schema/action.ts.
ALTER TABLE "action_destination" ADD CONSTRAINT "action_destination_destination_id_destination_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destination"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_action_id_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."action"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_item_id_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_destination_id_destination_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destination"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "digest_item" ADD CONSTRAINT "digest_item_action_id_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."action"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_item" ADD CONSTRAINT "digest_item_item_id_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_destination_destination_id_idx" ON "action_destination" USING btree ("destination_id");--> statement-breakpoint
CREATE INDEX "delivery_destination_id_status_next_attempt_at_idx" ON "delivery" USING btree ("destination_id","status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "delivery_item_id_idx" ON "delivery" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "digest_item_item_id_idx" ON "digest_item" USING btree ("item_id");--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_quiet_hours_check" CHECK (("workspace"."quiet_hours_start" is null) = ("workspace"."quiet_hours_end" is null));--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_alerts_per_hour_check" CHECK ("workspace"."alerts_per_hour" > 0);--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_burst_window_seconds_check" CHECK ("workspace"."burst_window_seconds" >= 0);--> statement-breakpoint
ALTER TABLE "item_log" ADD CONSTRAINT "item_log_stage_check" CHECK ("item_log"."stage" in ('capture', 'classify', 'extract', 'rate', 'correct', 'act'));