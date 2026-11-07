CREATE TABLE "sent_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"destination_id" uuid,
	"type" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sent_message_type_check" CHECK ("sent_message"."type" in ('telegram', 'email'))
);
--> statement-breakpoint
ALTER TABLE "sent_message" ADD CONSTRAINT "sent_message_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sent_message" ADD CONSTRAINT "sent_message_destination_id_destination_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destination"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sent_message_workspace_id_sent_at_idx" ON "sent_message" USING btree ("workspace_id","sent_at");--> statement-breakpoint
CREATE INDEX "sent_message_destination_id_sent_at_idx" ON "sent_message" USING btree ("destination_id","sent_at");--> statement-breakpoint
CREATE INDEX "sent_message_sent_at_idx" ON "sent_message" USING btree ("sent_at");