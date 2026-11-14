CREATE TABLE "audit_events" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"org_id" uuid NOT NULL,
	"space_id" uuid,
	"app_id" uuid,
	"env" text,
	"actor" jsonb NOT NULL,
	"action" text NOT NULL,
	"target" jsonb,
	"outcome" text NOT NULL,
	"reason" jsonb,
	"changes" jsonb,
	"context" jsonb,
	"digest" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_seals" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_seals_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"from_seq" bigint NOT NULL,
	"to_seq" bigint NOT NULL,
	"event_count" integer NOT NULL,
	"merkle_root" text NOT NULL,
	"prev_seal_hash" text,
	"sealed_at" timestamp with time zone NOT NULL,
	"key_id" text NOT NULL,
	"seal_hash" text NOT NULL,
	"signature" text NOT NULL,
	CONSTRAINT "audit_seals_range" CHECK ("audit_seals"."to_seq" >= "audit_seals"."from_seq")
);
--> statement-breakpoint
CREATE TABLE "bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"role_id" text,
	"permission_set_id" text,
	"scope_type" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"expires_at" timestamp with time zone,
	"justification" text,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "bindings_role_xor_permission_set" CHECK (("bindings"."role_id" is null) <> ("bindings"."permission_set_id" is null))
);
--> statement-breakpoint
CREATE TABLE "group_members" (
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guardrails" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"actions" text[] NOT NULL,
	"effect" text NOT NULL,
	"condition" jsonb,
	"max_mfa_age_seconds" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"managed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permission_set_grants" (
	"permission_set_id" text NOT NULL,
	"permission" text NOT NULL,
	"resource_selector" text DEFAULT '*' NOT NULL,
	"condition" jsonb,
	CONSTRAINT "permission_set_grants_permission_set_id_permission_resource_selector_pk" PRIMARY KEY("permission_set_id","permission","resource_selector")
);
--> statement-breakpoint
CREATE TABLE "permission_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"scope_type" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"managed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permission_sets" (
	"role_id" text NOT NULL,
	"permission_set_id" text NOT NULL,
	CONSTRAINT "role_permission_sets_role_id_permission_set_id_pk" PRIMARY KEY("role_id","permission_set_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"scope_type" text NOT NULL,
	"managed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"mfa_at" timestamp with time zone,
	"auth_time" timestamp with time zone,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spaces_personal_has_owner" CHECK (("spaces"."kind" = 'personal') = ("spaces"."owner_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"email" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"display_name" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "bindings" ADD CONSTRAINT "bindings_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bindings" ADD CONSTRAINT "bindings_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bindings" ADD CONSTRAINT "bindings_permission_set_id_permission_sets_id_fk" FOREIGN KEY ("permission_set_id") REFERENCES "public"."permission_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bindings" ADD CONSTRAINT "bindings_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bindings" ADD CONSTRAINT "bindings_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardrails" ADD CONSTRAINT "guardrails_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_set_grants" ADD CONSTRAINT "permission_set_grants_permission_set_id_permission_sets_id_fk" FOREIGN KEY ("permission_set_id") REFERENCES "public"."permission_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_sets" ADD CONSTRAINT "permission_sets_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permission_sets" ADD CONSTRAINT "role_permission_sets_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permission_sets" ADD CONSTRAINT "role_permission_sets_permission_set_id_permission_sets_id_fk" FOREIGN KEY ("permission_set_id") REFERENCES "public"."permission_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_id_uq" ON "audit_events" USING btree ("id");--> statement-breakpoint
CREATE INDEX "audit_events_org_time_idx" ON "audit_events" USING btree ("org_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_action_idx" ON "audit_events" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_events_space_idx" ON "audit_events" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "audit_events_recorded_idx" ON "audit_events" USING btree ("recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_seals_from_seq_uq" ON "audit_seals" USING btree ("from_seq");--> statement-breakpoint
CREATE INDEX "bindings_principal_idx" ON "bindings" USING btree ("principal_type","principal_id");--> statement-breakpoint
CREATE INDEX "bindings_scope_idx" ON "bindings" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bindings_active_role_uq" ON "bindings" USING btree ("principal_type","principal_id","scope_type","scope_id","role_id") WHERE "bindings"."revoked_at" is null and "bindings"."role_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "bindings_active_permission_set_uq" ON "bindings" USING btree ("principal_type","principal_id","scope_type","scope_id","permission_set_id") WHERE "bindings"."revoked_at" is null and "bindings"."permission_set_id" is not null;--> statement-breakpoint
CREATE INDEX "group_members_user_idx" ON "group_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_org_source_external_uq" ON "groups" USING btree ("org_id","source","external_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "spaces_one_personal_per_user_uq" ON "spaces" USING btree ("owner_user_id") WHERE "spaces"."kind" = 'personal';--> statement-breakpoint
CREATE UNIQUE INDEX "users_issuer_subject_uq" ON "users" USING btree ("issuer","subject");--> statement-breakpoint
CREATE INDEX "users_org_email_idx" ON "users" USING btree ("org_id","email");