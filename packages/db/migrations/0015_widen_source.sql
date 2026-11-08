CREATE TABLE "health_alert_destination" (
	"workspace_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	CONSTRAINT "health_alert_destination_workspace_id_destination_id_pk" PRIMARY KEY("workspace_id","destination_id")
);
--> statement-breakpoint
ALTER TABLE "source" DROP CONSTRAINT "source_type_check";--> statement-breakpoint
DROP INDEX "source_workspace_id_url_key";--> statement-breakpoint
ALTER TABLE "source" ALTER COLUMN "schedule" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "source" ALTER COLUMN "next_poll_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "source" ADD COLUMN "dedup_key" text GENERATED ALWAYS AS (case "type"
      when 'rss' then "config"->>'url'
      when 'github' then case "config"->>'kind'
        when 'mentions' then 'mentions:' || coalesce("config"->>'within', '') || ':' || btrim("config"->>'term')
        else lower(("config"->>'kind') || ':' || ("config"->>'repo')) end
      when 'website' then ("config"->>'url') || ' ' || btrim(coalesce("config"->>'region', ''))
      when 'telegram' then "config"->>'chatId'
    end) STORED;--> statement-breakpoint
ALTER TABLE "source" ADD COLUMN "health" text DEFAULT 'ok' NOT NULL;--> statement-breakpoint
ALTER TABLE "source" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "source" ADD COLUMN "last_success_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source" ADD COLUMN "secret_ciphertext" text;--> statement-breakpoint
ALTER TABLE "source" ADD COLUMN "inbox_token_hash" text;--> statement-breakpoint
ALTER TABLE "health_alert_destination" ADD CONSTRAINT "health_alert_destination_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_alert_destination" ADD CONSTRAINT "health_alert_destination_destination_id_destination_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destination"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "health_alert_destination_destination_id_idx" ON "health_alert_destination" USING btree ("destination_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_workspace_id_type_dedup_key_key" ON "source" USING btree ("workspace_id","type",md5("dedup_key"));--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_inbox_token_hash_key" UNIQUE("inbox_token_hash");--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_schedule_check" CHECK (case when "source"."type" in ('rss', 'github', 'website')
        then "source"."schedule" is not null and "source"."next_poll_at" is not null
        else "source"."schedule" is null and "source"."next_poll_at" is null end);--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_health_check" CHECK ("source"."health" in ('ok', 'degraded', 'failing'));--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_consecutive_failures_check" CHECK ("source"."consecutive_failures" >= 0);--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_type_check" CHECK ("source"."type" in ('rss', 'github', 'website', 'webhook', 'telegram'));