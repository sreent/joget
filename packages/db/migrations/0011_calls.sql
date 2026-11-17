ALTER TABLE "process_instances" ADD COLUMN "called_by_instance" uuid;--> statement-breakpoint
ALTER TABLE "process_instances" ADD COLUMN "called_by_token" uuid;--> statement-breakpoint
CREATE INDEX "process_instances_called_by_idx" ON "process_instances" USING btree ("called_by_token") WHERE "process_instances"."called_by_token" is not null;