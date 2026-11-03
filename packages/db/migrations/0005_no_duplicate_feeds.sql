-- A Workspace watches a feed URL once. Keep the oldest copy of each one; a newer copy's Items repeat
-- the oldest copy's entries, and they go with it (cascade).
DELETE FROM "source" AS "newer" USING "source" AS "older"
WHERE "older"."workspace_id" = "newer"."workspace_id"
  AND "older"."config"->>'url' = "newer"."config"->>'url'
  AND ("older"."created_at", "older"."id") < ("newer"."created_at", "newer"."id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_workspace_id_url_key" ON "source" USING btree ("workspace_id",("config"->>'url'));
