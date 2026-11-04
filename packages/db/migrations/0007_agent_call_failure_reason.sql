ALTER TABLE "agent_call" DROP CONSTRAINT "agent_call_purpose_check";--> statement-breakpoint
ALTER TABLE "agent_call" ADD COLUMN "error_message" text;--> statement-breakpoint
ALTER TABLE "agent_call" ADD CONSTRAINT "agent_call_purpose_check" CHECK ("agent_call"."purpose" in ('classify', 'extract-rate', 'compile-rule', 'draft-profile', 'test-connection'));