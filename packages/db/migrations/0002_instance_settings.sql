CREATE TABLE "instance_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"admin_user_id" text,
	"claimed_email" text,
	"setup_token_hash" text,
	"signup_open" boolean DEFAULT false NOT NULL,
	CONSTRAINT "instance_settings_single_row" CHECK ("instance_settings"."id")
);
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD CONSTRAINT "instance_settings_admin_user_id_user_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;