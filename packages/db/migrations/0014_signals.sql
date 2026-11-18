CREATE TABLE "process_signals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"name" text NOT NULL,
	"entity" text,
	"record_id" uuid,
	"instance_id" uuid,
	"element" text,
	"thrown_by" uuid,
	"thrown_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"heard" integer,
	"started" integer
);
--> statement-breakpoint
ALTER TABLE "process_signals" ADD CONSTRAINT "process_signals_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_signals" ADD CONSTRAINT "process_signals_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_signals" ADD CONSTRAINT "process_signals_environment_id_app_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."app_environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_signals" ADD CONSTRAINT "process_signals_instance_id_process_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."process_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_signals" ADD CONSTRAINT "process_signals_thrown_by_users_id_fk" FOREIGN KEY ("thrown_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "process_signals_due_idx" ON "process_signals" USING btree ("next_attempt_at") WHERE "process_signals"."status" = 'waiting';