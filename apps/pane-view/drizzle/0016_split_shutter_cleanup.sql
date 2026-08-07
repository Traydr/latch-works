ALTER TYPE "public"."maintenance_job_type" ADD VALUE IF NOT EXISTS 'shutter_source_purge';
--> statement-breakpoint
CREATE TABLE "shutter_source_cleanup" (
	"sha256" text PRIMARY KEY NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "shutter_source_cleanup_pending_idx" ON "shutter_source_cleanup" USING btree ("queued_at") WHERE "shutter_source_cleanup"."purged_at" is null;
