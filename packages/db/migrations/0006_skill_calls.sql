CREATE TABLE "skill_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"action" text NOT NULL,
	"record_id" uuid NOT NULL,
	"step" text NOT NULL,
	"skill" text NOT NULL,
	"label" text NOT NULL,
	"tier" text NOT NULL,
	"input" jsonb NOT NULL,
	"on_behalf_of" uuid,
	"proposal_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	CONSTRAINT "skill_calls_started_when" CHECK (("skill_calls"."status" = 'started') = ("skill_calls"."started_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "skill_calls" ADD CONSTRAINT "skill_calls_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_calls" ADD CONSTRAINT "skill_calls_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_calls" ADD CONSTRAINT "skill_calls_environment_id_app_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."app_environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_calls" ADD CONSTRAINT "skill_calls_on_behalf_of_users_id_fk" FOREIGN KEY ("on_behalf_of") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_calls" ADD CONSTRAINT "skill_calls_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_calls_due_idx" ON "skill_calls" USING btree ("next_attempt_at") WHERE "skill_calls"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "skill_calls_record_idx" ON "skill_calls" USING btree ("app_id","record_id");