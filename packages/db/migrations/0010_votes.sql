ALTER TABLE "process_tasks" ADD COLUMN "several" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "process_tokens" ADD COLUMN "voters" jsonb;