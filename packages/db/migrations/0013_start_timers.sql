CREATE TABLE "process_start_timers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"process" text NOT NULL,
	"element" text NOT NULL,
	"entity" text NOT NULL,
	"record_id" uuid NOT NULL,
	"fire_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fired_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "process_start_timers" ADD CONSTRAINT "process_start_timers_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_start_timers" ADD CONSTRAINT "process_start_timers_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_start_timers" ADD CONSTRAINT "process_start_timers_environment_id_app_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."app_environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "process_start_timers_one_uq" ON "process_start_timers" USING btree ("environment_id","process","element","record_id");--> statement-breakpoint
CREATE INDEX "process_start_timers_due_idx" ON "process_start_timers" USING btree ("next_attempt_at") WHERE "process_start_timers"."status" = 'waiting';