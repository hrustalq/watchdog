ALTER TABLE "source_alert" ADD COLUMN "event_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
CREATE INDEX "source_alert_event_id_idx" ON "source_alert" USING btree ("event_id");