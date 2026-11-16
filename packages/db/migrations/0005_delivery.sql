CREATE TABLE "change_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"working_copy_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'open' NOT NULL,
	"base_revision" integer NOT NULL,
	"head_revision" integer NOT NULL,
	"head_digest" text NOT NULL,
	"checks" jsonb NOT NULL,
	"author_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"merged_revision" integer,
	"merged_at" timestamp with time zone,
	"merged_by_type" text,
	"merged_by" uuid,
	"closed_at" timestamp with time zone,
	"closed_by_type" text,
	"closed_by" uuid
);
--> statement-breakpoint
CREATE TABLE "change_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"change_request_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"verdict" text NOT NULL,
	"head_digest" text NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment_approvals" (
	"deployment_id" uuid NOT NULL,
	"approver_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployment_approvals_deployment_id_approver_id_pk" PRIMARY KEY("deployment_id","approver_id")
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"environment_kind" text NOT NULL,
	"environment_id" uuid,
	"kind" text NOT NULL,
	"release_id" uuid NOT NULL,
	"from_release_id" uuid,
	"status" text NOT NULL,
	"plan" jsonb NOT NULL,
	"destructive" boolean NOT NULL,
	"approvals_required" integer NOT NULL,
	"requested_by_type" text NOT NULL,
	"requested_by" uuid,
	"requested_at" timestamp with time zone NOT NULL,
	"executed_by_type" text,
	"executed_by" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"revision" integer NOT NULL,
	"digest" text NOT NULL,
	"previous_release_id" uuid,
	"destructive" boolean NOT NULL,
	"contents" jsonb NOT NULL,
	"notes" text,
	"manifest_digest" text NOT NULL,
	"key_id" text NOT NULL,
	"signature" text NOT NULL,
	"created_by_type" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "app_environments_app_kind_uq";--> statement-breakpoint
-- Existing environments run the revision their schema has.
ALTER TABLE "app_environments" ADD COLUMN "active_revision" integer;--> statement-breakpoint
UPDATE "app_environments" SET "active_revision" = "applied_revision";--> statement-breakpoint
ALTER TABLE "app_environments" ALTER COLUMN "active_revision" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "app_environments" ADD COLUMN "active_release_id" uuid;--> statement-breakpoint
ALTER TABLE "app_environments" ADD COLUMN "change_request_id" uuid;--> statement-breakpoint
ALTER TABLE "app_revisions" ADD COLUMN "change_request_id" uuid;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "working_copy_of" uuid;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "base_revision" integer;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_working_copy_id_apps_id_fk" FOREIGN KEY ("working_copy_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_reviews" ADD CONSTRAINT "change_reviews_change_request_id_change_requests_id_fk" FOREIGN KEY ("change_request_id") REFERENCES "public"."change_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_reviews" ADD CONSTRAINT "change_reviews_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_approvals" ADD CONSTRAINT "deployment_approvals_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_approvals" ADD CONSTRAINT "deployment_approvals_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_environment_id_app_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."app_environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_from_release_id_releases_id_fk" FOREIGN KEY ("from_release_id") REFERENCES "public"."releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_previous_release_id_releases_id_fk" FOREIGN KEY ("previous_release_id") REFERENCES "public"."releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "change_requests_app_number_uq" ON "change_requests" USING btree ("app_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "change_requests_one_open_per_copy_uq" ON "change_requests" USING btree ("working_copy_id") WHERE "change_requests"."status" = 'open';--> statement-breakpoint
CREATE INDEX "change_requests_space_idx" ON "change_requests" USING btree ("space_id","status");--> statement-breakpoint
CREATE INDEX "change_reviews_request_idx" ON "change_reviews" USING btree ("change_request_id","created_at");--> statement-breakpoint
CREATE INDEX "deployments_app_idx" ON "deployments" USING btree ("app_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_one_open_per_env_uq" ON "deployments" USING btree ("app_id","environment_kind") WHERE "deployments"."status" in ('awaiting_approval', 'approved');--> statement-breakpoint
CREATE UNIQUE INDEX "releases_app_number_uq" ON "releases" USING btree ("app_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "releases_app_revision_uq" ON "releases" USING btree ("app_id","revision");--> statement-breakpoint
ALTER TABLE "app_environments" ADD CONSTRAINT "app_environments_active_release_id_releases_id_fk" FOREIGN KEY ("active_release_id") REFERENCES "public"."releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_environments" ADD CONSTRAINT "app_environments_change_request_id_change_requests_id_fk" FOREIGN KEY ("change_request_id") REFERENCES "public"."change_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_working_copy_of_apps_id_fk" FOREIGN KEY ("working_copy_of") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_environments_preview_uq" ON "app_environments" USING btree ("change_request_id") WHERE "app_environments"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "apps_one_working_copy_uq" ON "apps" USING btree ("working_copy_of","owner_user_id") WHERE "apps"."status" = 'active' and "apps"."working_copy_of" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "app_environments_app_kind_uq" ON "app_environments" USING btree ("app_id","kind") WHERE "app_environments"."status" = 'active' and "app_environments"."kind" <> 'preview';--> statement-breakpoint
ALTER TABLE "app_environments" ADD CONSTRAINT "app_environments_previews_show_changes" CHECK (("app_environments"."kind" = 'preview') = ("app_environments"."change_request_id" is not null));--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_working_copy_has_base" CHECK (("apps"."working_copy_of" is null) = ("apps"."base_revision" is null));--> statement-breakpoint
-- Releases are immutable (design §6.7): a rollback re-activates an earlier release, it never edits one.
CREATE FUNCTION release_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Releases are immutable: % is not allowed', TG_OP
    USING ERRCODE = '42501';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER releases_immutable BEFORE UPDATE OR DELETE ON releases
  FOR EACH ROW EXECUTE FUNCTION release_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER releases_no_truncate BEFORE TRUNCATE ON releases
  FOR EACH STATEMENT EXECUTE FUNCTION release_reject_mutation();
