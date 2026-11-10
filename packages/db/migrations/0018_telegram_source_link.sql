ALTER TABLE "telegram_link_code" ALTER COLUMN "destination_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_link_code" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "telegram_link_code" ADD CONSTRAINT "telegram_link_code_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_telegram_chat_idx" ON "source" USING btree ("dedup_key") WHERE "source"."type" = 'telegram';--> statement-breakpoint
ALTER TABLE "telegram_link_code" ADD CONSTRAINT "telegram_link_code_target_check" CHECK (num_nonnulls("telegram_link_code"."destination_id", "telegram_link_code"."source_id") = 1);