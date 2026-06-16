CREATE TYPE "public"."derivative_queue_source" AS ENUM('prewarm', 'on-demand');--> statement-breakpoint
CREATE TYPE "public"."derivative_queue_variant" AS ENUM('thumbnail', 'preview');--> statement-breakpoint
ALTER TABLE "thumbnails" ADD COLUMN "queue_source" "derivative_queue_source" DEFAULT 'prewarm' NOT NULL;--> statement-breakpoint
ALTER TABLE "thumbnails" ADD COLUMN "queue_variant" "derivative_queue_variant" DEFAULT 'thumbnail' NOT NULL;--> statement-breakpoint
ALTER TABLE "thumbnails" ADD COLUMN "queue_priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "thumbnails" ADD COLUMN "priority_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "thumbnails"
SET
  "queue_variant" = CASE WHEN "size" = 960 THEN 'preview'::"derivative_queue_variant" ELSE 'thumbnail'::"derivative_queue_variant" END,
  "queue_priority" = CASE WHEN "size" = 960 THEN 100 ELSE 0 END,
  "priority_at" = "created_at";--> statement-breakpoint
DROP INDEX IF EXISTS "thumbnails_pending_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "thumbnails_pending_priority_idx" ON "thumbnails" USING btree ("queue_priority" DESC, "priority_at" DESC, "created_at" DESC) WHERE "thumbnails"."status" = 'pending';
