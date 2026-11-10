CREATE TABLE "source_alert" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"destination_id" uuid,
	"kind" text NOT NULL,
	"error" text,
	"status" text DEFAULT 'held' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now(),
	"retry_from" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_alert_kind_check" CHECK ("source_alert"."kind" in ('failing', 'recovered')),
	CONSTRAINT "source_alert_status_check" CHECK ("source_alert"."status" in ('queued', 'held', 'sent', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "source_alert" ADD CONSTRAINT "source_alert_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_alert" ADD CONSTRAINT "source_alert_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_alert" ADD CONSTRAINT "source_alert_destination_id_destination_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destination"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_alert_held_next_attempt_at_idx" ON "source_alert" USING btree ("next_attempt_at") WHERE "source_alert"."status" = 'held';--> statement-breakpoint
CREATE INDEX "source_alert_source_id_idx" ON "source_alert" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "source_alert_destination_id_idx" ON "source_alert" USING btree ("destination_id");--> statement-breakpoint
-- Until now only a successful poll set last_polled_at, and nothing set last_success_at. Without this, a
-- Source that has polled fine for weeks would count its 24 hours with no success from when it was created.
UPDATE "source" SET "last_success_at" = "last_polled_at" WHERE "last_success_at" IS NULL AND "last_polled_at" IS NOT NULL;
