CREATE TYPE "public"."maintenance_job_type" AS ENUM('library_hard_wipe');--> statement-breakpoint
CREATE TYPE "public"."maintenance_job_status" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "maintenance_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "maintenance_job_type" NOT NULL,
	"status" "maintenance_job_status" DEFAULT 'pending' NOT NULL,
	"progress" jsonb DEFAULT '{"errorCount":0,"phase":"s3_derivatives","processedCount":0}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "maintenance_jobs_status_idx" ON "maintenance_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "maintenance_jobs_type_status_idx" ON "maintenance_jobs" USING btree ("type","status");
