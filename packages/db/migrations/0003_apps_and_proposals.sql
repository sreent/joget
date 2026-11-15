CREATE TABLE "app_environments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"app_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"schema_name" text NOT NULL,
	"db_role" text NOT NULL,
	"applied_revision" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_revisions" (
	"app_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"digest" text NOT NULL,
	"summary" jsonb,
	"created_by_type" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_revisions_app_id_revision_pk" PRIMARY KEY("app_id","revision")
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"handle" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"owner_user_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_revision" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"action" text NOT NULL,
	"revision" integer NOT NULL,
	"record_id" uuid,
	"base_version" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"effect" jsonb NOT NULL,
	"findings" jsonb NOT NULL,
	"provenance" jsonb NOT NULL,
	"card" jsonb NOT NULL,
	"digest" text NOT NULL,
	"proposed_by_type" text NOT NULL,
	"proposed_by" uuid,
	"proposed_with_token" uuid,
	"on_behalf_of" uuid NOT NULL,
	"revises" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"result_record_id" uuid
);
--> statement-breakpoint
ALTER TABLE "bindings" DROP CONSTRAINT "bindings_role_xor_permission_set";--> statement-breakpoint
ALTER TABLE "bindings" ADD COLUMN "app_role_id" text;--> statement-breakpoint
ALTER TABLE "app_environments" ADD CONSTRAINT "app_environments_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_revisions" ADD CONSTRAINT "app_revisions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_environment_id_app_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."app_environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_on_behalf_of_users_id_fk" FOREIGN KEY ("on_behalf_of") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_environments_schema_uq" ON "app_environments" USING btree ("schema_name");--> statement-breakpoint
CREATE UNIQUE INDEX "app_environments_app_kind_uq" ON "app_environments" USING btree ("app_id","kind") WHERE "app_environments"."status" = 'active';--> statement-breakpoint
CREATE INDEX "apps_space_idx" ON "apps" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "apps_space_handle_uq" ON "apps" USING btree ("space_id","handle") WHERE "apps"."status" = 'active';--> statement-breakpoint
CREATE INDEX "proposals_person_idx" ON "proposals" USING btree ("on_behalf_of","status");--> statement-breakpoint
CREATE INDEX "proposals_app_idx" ON "proposals" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bindings_active_app_role_uq" ON "bindings" USING btree ("principal_type","principal_id","scope_type","scope_id","app_role_id") WHERE "bindings"."revoked_at" is null and "bindings"."app_role_id" is not null;--> statement-breakpoint
ALTER TABLE "bindings" ADD CONSTRAINT "bindings_grants_one_thing" CHECK (num_nonnulls("bindings"."role_id", "bindings"."permission_set_id", "bindings"."app_role_id") = 1);--> statement-breakpoint
ALTER TABLE "bindings" ADD CONSTRAINT "bindings_app_roles_inside_apps" CHECK ("bindings"."app_role_id" is null or "bindings"."scope_type" in ('app', 'env'));