CREATE TABLE "notice_emails" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"notice_id" uuid NOT NULL,
	"address" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"message" text,
	"entity" text,
	"record_id" uuid,
	"label" text,
	"task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "process_tasks" ADD COLUMN "due_soon_notice_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "process_tasks" ADD COLUMN "overdue_notice_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_notices" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notice_emails" ADD CONSTRAINT "notice_emails_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_emails" ADD CONSTRAINT "notice_emails_notice_id_notices_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."notices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_environment_id_app_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."app_environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notice_emails_due_idx" ON "notice_emails" USING btree ("next_attempt_at") WHERE "notice_emails"."status" = 'waiting';--> statement-breakpoint
CREATE INDEX "notices_user_idx" ON "notices" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notices_unread_idx" ON "notices" USING btree ("user_id") WHERE "notices"."read_at" is null;--> statement-breakpoint
CREATE INDEX "process_tasks_due_idx" ON "process_tasks" USING btree ("due_at") WHERE "process_tasks"."status" = 'open' and "process_tasks"."due_at" is not null;