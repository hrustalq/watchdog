ALTER TABLE "source" ADD COLUMN "inbox_window_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source" ADD COLUMN "inbox_window_requests" integer DEFAULT 0 NOT NULL;