CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"service_account_id" uuid,
	"name" text NOT NULL,
	"display_prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_type" text,
	"revoked_by" uuid,
	CONSTRAINT "api_tokens_one_owner" CHECK (("api_tokens"."user_id" is null) <> ("api_tokens"."service_account_id" is null))
);
--> statement-breakpoint
CREATE TABLE "service_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "bindings" DROP CONSTRAINT "bindings_granted_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "bindings" DROP CONSTRAINT "bindings_revoked_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "bindings" ADD COLUMN "granted_by_type" text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "bindings" ADD COLUMN "revoked_by_type" text;--> statement-breakpoint
-- Backfill: existing grants and revocations with a recorded person were made by users. Rows with no
-- granter keep the default 'system' (the platform granted them).
UPDATE "bindings" SET "granted_by_type" = 'user' WHERE "granted_by" IS NOT NULL;--> statement-breakpoint
UPDATE "bindings" SET "revoked_by_type" = 'user' WHERE "revoked_by" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_secret_hash_uq" ON "api_tokens" USING btree ("secret_hash");--> statement-breakpoint
CREATE INDEX "api_tokens_user_idx" ON "api_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "api_tokens_service_account_idx" ON "api_tokens" USING btree ("service_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_accounts_space_name_uq" ON "service_accounts" USING btree ("space_id","name");