CREATE TABLE "source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"schedule" text NOT NULL,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_polled_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"fetch_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"backfilled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "source_type_check" CHECK ("source"."type" in ('rss'))
);
--> statement-breakpoint
CREATE TABLE "item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"url" text,
	"title" text,
	"author" text,
	"body" text NOT NULL,
	"published_at" timestamp with time zone,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"language" text,
	"is_backfill" boolean DEFAULT false NOT NULL,
	"raw" jsonb NOT NULL,
	"summary" text,
	CONSTRAINT "item_source_id_external_id_key" UNIQUE("source_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "item_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "item_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"item_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"stage" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "item_log_stage_check" CHECK ("item_log"."stage" in ('capture'))
);
--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item" ADD CONSTRAINT "item_source_fk" FOREIGN KEY ("workspace_id","source_id") REFERENCES "public"."source"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_log" ADD CONSTRAINT "item_log_item_id_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_next_poll_at_idx" ON "source" USING btree ("next_poll_at");--> statement-breakpoint
CREATE INDEX "item_feed_idx" ON "item" USING btree ("workspace_id","captured_at" DESC NULLS FIRST,coalesce("published_at", '-infinity') desc,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "item_log_item_id_at_idx" ON "item_log" USING btree ("item_id","at");