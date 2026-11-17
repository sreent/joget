ALTER TABLE "process_tasks" ADD COLUMN "department" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "department" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "manager_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "cover_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "cover_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_manager_id_users_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_cover_id_users_id_fk" FOREIGN KEY ("cover_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_manager_idx" ON "users" USING btree ("manager_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_not_own_manager" CHECK ("users"."manager_id" is distinct from "users"."id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_not_own_cover" CHECK ("users"."cover_id" is distinct from "users"."id");