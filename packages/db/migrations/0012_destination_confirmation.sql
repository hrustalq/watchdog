CREATE TABLE "destination_confirmation" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"destination_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "destination_confirmation_destination_id_unique" UNIQUE("destination_id")
);
--> statement-breakpoint
ALTER TABLE "destination" ADD COLUMN "secret_shown_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "destination_confirmation" ADD CONSTRAINT "destination_confirmation_destination_id_destination_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destination"("id") ON DELETE cascade ON UPDATE no action;