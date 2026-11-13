-- GitHub search ignores case, so a mentions Source's term is part of its key in lower case, as its
-- `within` limit already is (docs: Sources and ingestion, "Uniqueness"). Hand-written: drizzle-kit
-- drops and re-adds the generated column, which would take the unique index with it. Postgres 18
-- can change a generated column's expression in place, keeping the index and the column's values.
-- No add can slip a duplicate in between the DELETE and the new expression.
LOCK TABLE "source" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
-- Keep the oldest copy of each mentions search whose term now differs in case only: a newer copy
-- captured the same Items, and they go with it (cascade).
DELETE FROM "source" AS "newer" USING "source" AS "older"
WHERE "older"."workspace_id" = "newer"."workspace_id"
  AND "older"."type" = 'github'
  AND "newer"."type" = 'github'
  AND "older"."config"->>'kind' = 'mentions'
  AND "newer"."config"->>'kind' = 'mentions'
  AND coalesce("older"."config"->>'within', '') = coalesce("newer"."config"->>'within', '')
  AND lower(btrim("older"."config"->>'term')) = lower(btrim("newer"."config"->>'term'))
  AND ("older"."created_at", "older"."id") < ("newer"."created_at", "newer"."id");--> statement-breakpoint
ALTER TABLE "source" ALTER COLUMN "dedup_key" SET EXPRESSION AS (case "type"
      when 'rss' then "config"->>'url'
      when 'github' then case "config"->>'kind'
        when 'mentions' then 'mentions:' || coalesce("config"->>'within', '') || ':' || lower(btrim("config"->>'term'))
        else lower(("config"->>'kind') || ':' || ("config"->>'repo')) end
      when 'website' then ("config"->>'url') || ' ' || btrim(coalesce("config"->>'region', ''))
      when 'telegram' then "config"->>'chatId'
    end);
