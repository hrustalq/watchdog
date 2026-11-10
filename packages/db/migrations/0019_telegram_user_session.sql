CREATE TABLE "telegram_login" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"step" text DEFAULT 'starting' NOT NULL,
	"code_ciphertext" text,
	"password_ciphertext" text,
	"refusal" text,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '5 minutes' NOT NULL,
	CONSTRAINT "telegram_login_workspace_id_key" UNIQUE("workspace_id"),
	CONSTRAINT "telegram_login_step_check" CHECK ("telegram_login"."step" in ('starting', 'code', 'password', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "telegram_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account" text NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_session_workspace_id_key" UNIQUE("workspace_id")
);
--> statement-breakpoint
ALTER TABLE "telegram_login" ADD CONSTRAINT "telegram_login_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_session" ADD CONSTRAINT "telegram_session_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;