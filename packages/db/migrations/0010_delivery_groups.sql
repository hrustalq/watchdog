ALTER TABLE "delivery" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery" ADD COLUMN "retry_from" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "delivery_waiting_next_attempt_at_idx" ON "delivery" USING btree ("next_attempt_at") WHERE "delivery"."status" in ('held', 'grouped');