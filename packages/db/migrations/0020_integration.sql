CREATE TABLE "app_secrets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"sealed" text NOT NULL,
	"set_by_type" text NOT NULL,
	"set_by" uuid NOT NULL,
	"set_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_posts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"connection" text NOT NULL,
	"title" text NOT NULL,
	"message" text,
	"link" text,
	"status" text DEFAULT 'waiting' NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app_secrets" ADD CONSTRAINT "app_secrets_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_secrets" ADD CONSTRAINT "app_secrets_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_secrets" ADD CONSTRAINT "app_secrets_environment_id_app_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."app_environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_posts" ADD CONSTRAINT "channel_posts_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_posts" ADD CONSTRAINT "channel_posts_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_posts" ADD CONSTRAINT "channel_posts_environment_id_app_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."app_environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_secrets_one_uq" ON "app_secrets" USING btree ("environment_id","kind","name");--> statement-breakpoint
CREATE INDEX "channel_posts_due_idx" ON "channel_posts" USING btree ("next_attempt_at") WHERE "channel_posts"."status" = 'waiting';