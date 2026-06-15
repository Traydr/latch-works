ALTER TABLE "thumbnails" ADD COLUMN IF NOT EXISTS "processing_token" text;--> statement-breakpoint
ALTER TABLE "thumbnails" ADD COLUMN IF NOT EXISTS "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "thumbnails" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "thumbnails_pending_idx" ON "thumbnails" USING btree ("next_attempt_at") WHERE "thumbnails"."status" = 'pending';
