ALTER TABLE "apps" ADD COLUMN "promoted_from" uuid;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "moved_to" uuid;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_promoted_from_apps_id_fk" FOREIGN KEY ("promoted_from") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_moved_to_apps_id_fk" FOREIGN KEY ("moved_to") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "apps_one_promotion_uq" ON "apps" USING btree ("promoted_from") WHERE "apps"."status" = 'active' and "apps"."promoted_from" is not null;