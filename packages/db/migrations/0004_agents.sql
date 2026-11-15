ALTER TABLE "api_tokens" ADD COLUMN "actor_service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD COLUMN "agent_scopes" text[];--> statement-breakpoint
ALTER TABLE "service_accounts" ADD COLUMN "agent_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD COLUMN "agent_approved_by" uuid;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_actor_service_account_id_service_accounts_id_fk" FOREIGN KEY ("actor_service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_tokens_actor_idx" ON "api_tokens" USING btree ("actor_service_account_id");--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_delegated_to_people" CHECK ("api_tokens"."actor_service_account_id" is null or "api_tokens"."user_id" is not null);