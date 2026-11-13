ALTER TABLE "agent_call" ADD COLUMN "input_price_per_million" numeric;--> statement-breakpoint
ALTER TABLE "agent_call" ADD COLUMN "output_price_per_million" numeric;--> statement-breakpoint
-- A call made before these columns existed keeps the estimate Usage showed for it: its model's
-- prices as they stand now, which is what the screen read in place of a stored price. Half a price
-- is no price, so a model with only one set leaves its calls without either, as each call does.
UPDATE "agent_call"
SET "input_price_per_million" = "model_config"."input_price_per_million",
    "output_price_per_million" = "model_config"."output_price_per_million"
FROM "model_config"
WHERE "model_config"."id" = "agent_call"."model_config_id"
  AND "model_config"."input_price_per_million" IS NOT NULL
  AND "model_config"."output_price_per_million" IS NOT NULL;
