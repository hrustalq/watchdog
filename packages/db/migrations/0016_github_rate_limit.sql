CREATE TABLE "github_rate_limit" (
	"token_hash" text NOT NULL,
	"resource" text NOT NULL,
	"remaining" integer,
	"reset_at" timestamp with time zone,
	"retry_at" timestamp with time zone,
	"window_start" timestamp with time zone,
	"window_calls" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "github_rate_limit_token_hash_resource_pk" PRIMARY KEY("token_hash","resource"),
	CONSTRAINT "github_rate_limit_resource_check" CHECK ("github_rate_limit"."resource" in ('core', 'search'))
);
