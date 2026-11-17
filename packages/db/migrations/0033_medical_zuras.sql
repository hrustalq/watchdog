ALTER TABLE "workspace" DROP CONSTRAINT "workspace_owner_user_id_unique";--> statement-breakpoint
CREATE INDEX "workspace_owner_created_idx" ON "workspace" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_owner_name_key" ON "workspace" USING btree ("owner_user_id","name");