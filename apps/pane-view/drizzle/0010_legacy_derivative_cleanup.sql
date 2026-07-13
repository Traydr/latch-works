ALTER TYPE "public"."maintenance_job_type" ADD VALUE IF NOT EXISTS 'legacy_derivative_cleanup';--> statement-breakpoint
UPDATE "maintenance_jobs"
SET "progress" = jsonb_set("progress", '{phase}', '"s3_originals"'::jsonb)
WHERE "type" = 'library_hard_wipe'
  AND "status" IN ('pending', 'running')
  AND "progress"->>'phase' = 's3_derivatives';
