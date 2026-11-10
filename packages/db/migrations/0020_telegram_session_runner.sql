ALTER TABLE "telegram_session" ADD COLUMN "dialogs" jsonb;--> statement-breakpoint
ALTER TABLE "telegram_session" ADD COLUMN "wait_until" timestamp with time zone;