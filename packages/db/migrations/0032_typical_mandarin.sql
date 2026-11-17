ALTER TABLE "model_config" ADD COLUMN "pricing_source" text;--> statement-breakpoint
ALTER TABLE "model_config" ADD COLUMN "pricing_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_config" ADD CONSTRAINT "model_config_pricing_source_check" CHECK ("model_config"."pricing_source" in ('provider', 'manual'));--> statement-breakpoint
-- Prices already in the table were typed by a person, because nothing else could have put them there.
-- A row with neither price keeps a null source, which is the same as an unpaid model.
UPDATE "model_config" SET "pricing_source" = 'manual'
  WHERE "input_price_per_million" IS NOT NULL AND "output_price_per_million" IS NOT NULL;
