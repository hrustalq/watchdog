ALTER TABLE "agent_call" DROP CONSTRAINT "agent_call_purpose_check";--> statement-breakpoint
ALTER TABLE "agent_call" ADD COLUMN "error_message" text;--> statement-breakpoint
CREATE INDEX "agent_call_failures_idx" ON "agent_call" USING btree ("model_config_id","created_at") WHERE "agent_call"."status" <> 'ok';--> statement-breakpoint
ALTER TABLE "agent_call" ADD CONSTRAINT "agent_call_purpose_check" CHECK ("agent_call"."purpose" in ('classify', 'extract-rate', 'compile-rule', 'draft-profile', 'test-connection'));