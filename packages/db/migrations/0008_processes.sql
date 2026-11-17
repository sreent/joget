CREATE TABLE "process_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "process_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"instance_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"element" text,
	"by" uuid,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "process_instances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"process" text NOT NULL,
	"revision" integer NOT NULL,
	"entity" text NOT NULL,
	"record_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"outcomes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_by" uuid,
	"started_by_action" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "process_instances_ended_when" CHECK (("process_instances"."status" = 'running') = ("process_instances"."ended_at" is null))
);
--> statement-breakpoint
CREATE TABLE "process_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"element" text NOT NULL,
	"token_id" uuid,
	"name" text NOT NULL,
	"entity" text NOT NULL,
	"record_id" uuid NOT NULL,
	"role" text NOT NULL,
	"assignee" uuid,
	"outcomes" jsonb NOT NULL,
	"card" text,
	"status" text DEFAULT 'open' NOT NULL,
	"outcome" text,
	"completed_by" uuid,
	"cancel_reason" text,
	"due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "process_tasks_closed_when" CHECK (("process_tasks"."status" = 'open') = ("process_tasks"."closed_at" is null)),
	CONSTRAINT "process_tasks_outcome_when" CHECK (("process_tasks"."status" = 'completed') = ("process_tasks"."outcome" is not null))
);
--> statement-breakpoint
CREATE TABLE "process_timers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"element" text NOT NULL,
	"token_id" uuid,
	"task_id" uuid,
	"fire_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fired_at" timestamp with time zone,
	CONSTRAINT "process_timers_one_place" CHECK (("process_timers"."token_id" is null) <> ("process_timers"."task_id" is null))
);
--> statement-breakpoint
CREATE TABLE "process_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"instance_id" uuid NOT NULL,
	"element" text NOT NULL,
	"arrived_by" text,
	"state" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "process_tokens_stuck_why" CHECK (("process_tokens"."state" = 'stuck') = ("process_tokens"."error" is not null))
);
--> statement-breakpoint
ALTER TABLE "process_events" ADD CONSTRAINT "process_events_instance_id_process_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."process_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_events" ADD CONSTRAINT "process_events_by_users_id_fk" FOREIGN KEY ("by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_instances" ADD CONSTRAINT "process_instances_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_instances" ADD CONSTRAINT "process_instances_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_instances" ADD CONSTRAINT "process_instances_environment_id_app_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."app_environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_instances" ADD CONSTRAINT "process_instances_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_tasks" ADD CONSTRAINT "process_tasks_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_tasks" ADD CONSTRAINT "process_tasks_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_tasks" ADD CONSTRAINT "process_tasks_environment_id_app_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."app_environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_tasks" ADD CONSTRAINT "process_tasks_instance_id_process_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."process_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_tasks" ADD CONSTRAINT "process_tasks_assignee_users_id_fk" FOREIGN KEY ("assignee") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_tasks" ADD CONSTRAINT "process_tasks_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_timers" ADD CONSTRAINT "process_timers_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_timers" ADD CONSTRAINT "process_timers_instance_id_process_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."process_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_timers" ADD CONSTRAINT "process_timers_task_id_process_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."process_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_tokens" ADD CONSTRAINT "process_tokens_instance_id_process_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."process_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "process_events_instance_idx" ON "process_events" USING btree ("instance_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "process_instances_one_running_uq" ON "process_instances" USING btree ("environment_id","process","record_id") WHERE "process_instances"."status" = 'running';--> statement-breakpoint
CREATE INDEX "process_instances_app_idx" ON "process_instances" USING btree ("app_id","environment_id","status");--> statement-breakpoint
CREATE INDEX "process_instances_record_idx" ON "process_instances" USING btree ("environment_id","record_id");--> statement-breakpoint
CREATE INDEX "process_tasks_open_idx" ON "process_tasks" USING btree ("environment_id","role") WHERE "process_tasks"."status" = 'open';--> statement-breakpoint
CREATE INDEX "process_tasks_assignee_idx" ON "process_tasks" USING btree ("assignee") WHERE "process_tasks"."status" = 'open';--> statement-breakpoint
CREATE INDEX "process_tasks_record_idx" ON "process_tasks" USING btree ("environment_id","record_id");--> statement-breakpoint
CREATE INDEX "process_tasks_instance_idx" ON "process_tasks" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "process_timers_due_idx" ON "process_timers" USING btree ("next_attempt_at") WHERE "process_timers"."status" = 'waiting';--> statement-breakpoint
CREATE INDEX "process_timers_instance_idx" ON "process_timers" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "process_tokens_instance_idx" ON "process_tokens" USING btree ("instance_id");