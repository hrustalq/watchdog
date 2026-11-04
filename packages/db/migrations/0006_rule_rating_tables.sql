CREATE TABLE "classifier" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"definition" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "classifier_workspace_id_name_key" UNIQUE("workspace_id","name"),
	CONSTRAINT "classifier_kind_check" CHECK ("classifier"."kind" in ('deterministic', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "extractor_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"definition" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extractor_rule_workspace_id_name_key" UNIQUE("workspace_id","name"),
	CONSTRAINT "extractor_rule_kind_check" CHECK ("extractor_rule"."kind" in ('deterministic', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "item_category" (
	"item_id" uuid NOT NULL,
	"category" text NOT NULL,
	"classifier_id" uuid,
	CONSTRAINT "item_category_item_id_category_pk" PRIMARY KEY("item_id","category")
);
--> statement-breakpoint
CREATE TABLE "item_field" (
	"item_id" uuid NOT NULL,
	"name" text NOT NULL,
	"value" jsonb NOT NULL,
	"extractor_rule_id" uuid,
	CONSTRAINT "item_field_item_id_name_pk" PRIMARY KEY("item_id","name")
);
--> statement-breakpoint
CREATE TABLE "correction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"item_id" uuid,
	"kind" text NOT NULL,
	"item_title" text,
	"item_summary" text,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "correction_kind_check" CHECK ("correction"."kind" in ('rating', 'categories'))
);
--> statement-breakpoint
CREATE TABLE "profile" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"body" text NOT NULL,
	"output_language" text DEFAULT 'en' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"model_config_id" uuid NOT NULL,
	"item_id" uuid,
	"purpose" text NOT NULL,
	"attempt" integer NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_call_purpose_check" CHECK ("agent_call"."purpose" in ('classify', 'extract-rate', 'compile-rule', 'draft-profile')),
	CONSTRAINT "agent_call_status_check" CHECK ("agent_call"."status" in ('ok', 'invalid_output', 'error'))
);
--> statement-breakpoint
CREATE TABLE "model_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider_type" text NOT NULL,
	"base_url" text NOT NULL,
	"model_name" text NOT NULL,
	"api_key_ciphertext" text,
	"supports_structured_output" boolean DEFAULT false NOT NULL,
	"input_price_per_million" numeric,
	"output_price_per_million" numeric,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_config_provider_type_check" CHECK ("model_config"."provider_type" in ('openai-compatible', 'anthropic', 'google'))
);
--> statement-breakpoint
ALTER TABLE "item_log" DROP CONSTRAINT "item_log_stage_check";--> statement-breakpoint
ALTER TABLE "item" ADD COLUMN "severity" smallint;--> statement-breakpoint
ALTER TABLE "item" ADD COLUMN "importance" smallint;--> statement-breakpoint
ALTER TABLE "item" ADD COLUMN "classified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "item" ADD COLUMN "rated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "item" ADD COLUMN "rating_corrected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "item" ADD COLUMN "categories_corrected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "item" ADD COLUMN "processed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "classifier" ADD CONSTRAINT "classifier_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractor_rule" ADD CONSTRAINT "extractor_rule_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_category" ADD CONSTRAINT "item_category_item_id_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_category" ADD CONSTRAINT "item_category_classifier_id_classifier_id_fk" FOREIGN KEY ("classifier_id") REFERENCES "public"."classifier"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_field" ADD CONSTRAINT "item_field_item_id_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_field" ADD CONSTRAINT "item_field_extractor_rule_id_extractor_rule_id_fk" FOREIGN KEY ("extractor_rule_id") REFERENCES "public"."extractor_rule"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction" ADD CONSTRAINT "correction_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction" ADD CONSTRAINT "correction_item_id_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile" ADD CONSTRAINT "profile_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_call" ADD CONSTRAINT "agent_call_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_call" ADD CONSTRAINT "agent_call_model_config_id_model_config_id_fk" FOREIGN KEY ("model_config_id") REFERENCES "public"."model_config"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_call" ADD CONSTRAINT "agent_call_item_id_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_config" ADD CONSTRAINT "model_config_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "correction_item_id_kind_key" ON "correction" USING btree ("item_id","kind") WHERE "correction"."item_id" is not null;--> statement-breakpoint
CREATE INDEX "correction_workspace_id_created_at_idx" ON "correction" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_call_workspace_id_created_at_idx" ON "agent_call" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_call_item_id_idx" ON "agent_call" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_config_workspace_id_active_key" ON "model_config" USING btree ("workspace_id") WHERE "model_config"."archived_at" is null;--> statement-breakpoint
ALTER TABLE "item" ADD CONSTRAINT "item_severity_check" CHECK ("item"."severity" between 1 and 5);--> statement-breakpoint
ALTER TABLE "item" ADD CONSTRAINT "item_importance_check" CHECK ("item"."importance" between 1 and 5);--> statement-breakpoint
ALTER TABLE "item_log" ADD CONSTRAINT "item_log_stage_check" CHECK ("item_log"."stage" in ('capture', 'classify', 'extract', 'rate', 'correct'));