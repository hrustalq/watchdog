-- A Digest's collected Items belong to each of its Destinations, so the hosted email cap can hold some of
-- its addresses while the rest of the Digest goes out (GitHub issue #249). Hand-written rather than
-- generated: drizzle-kit would add `destination_id NOT NULL` to a table that already has rows, and would
-- put the new key on before the column existed.
--
-- Existing rows get one row per Destination the Digest points at, which is the set the whole Digest went
-- to before this change, so nothing collected is lost.
ALTER TABLE "digest_item" ADD COLUMN "destination_id" uuid;--> statement-breakpoint
ALTER TABLE "digest_item" ADD COLUMN "held_until" timestamp with time zone;--> statement-breakpoint
-- The old key goes before the backfill, which writes a second row for an Item that has two Destinations.
ALTER TABLE "digest_item" DROP CONSTRAINT "digest_item_action_id_item_id_pk";--> statement-breakpoint
INSERT INTO "digest_item" ("action_id", "item_id", "destination_id")
SELECT "digest_item"."action_id", "digest_item"."item_id", "action_destination"."destination_id"
FROM "digest_item"
INNER JOIN "action_destination" ON "action_destination"."action_id" = "digest_item"."action_id";--> statement-breakpoint
-- A Digest with no Destination left has nowhere to send these and no Destination to hold them for, as when
-- a Destination is taken off an Action.
DELETE FROM "digest_item" WHERE "destination_id" IS NULL;--> statement-breakpoint
ALTER TABLE "digest_item" ALTER COLUMN "destination_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "digest_item" ADD CONSTRAINT "digest_item_action_id_item_id_destination_id_pk" PRIMARY KEY("action_id","item_id","destination_id");--> statement-breakpoint
ALTER TABLE "digest_item" ADD CONSTRAINT "digest_item_destination_id_destination_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destination"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "digest_item_destination_id_idx" ON "digest_item" USING btree ("destination_id");--> statement-breakpoint
CREATE INDEX "digest_item_held_until_idx" ON "digest_item" USING btree ("held_until") WHERE "digest_item"."held_until" is not null;
