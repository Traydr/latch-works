-- 0022_drop_dead_schema: drop tables, columns and enum values nothing uses.
--
-- DATA-DESTROYING. Railway runs `pnpm db:migrate` before every deploy, so
-- deploying the version that carries this file applies it: take a backup you
-- are prepared to restore from before that deploy (see the Pane View README).
--
-- Dropped tables, with any rows they hold: api_tokens, sources, collections,
-- collection_items, favorites (nothing ever wrote them; sync authenticates
-- with PANE_VIEW_SYNC_TOKEN). Dropped columns, never read by Pane View:
-- users.password_hash/role (Better Auth keeps the password in accounts);
-- folders.entry_count/folder_count/depth; media_objects.width/height/
-- duration_ms/page_count/storage_provider/bucket/etag/created_by_sync_run_id/
-- metadata; library_entries.source/source_id/source_ref_id/last_sync_run_id/
-- hidden/changed_at/content_changed_at/path_changed_at/last_seen_at/metadata,
-- and its sha256/size copies of the media object's; sync_runs.source_id/
-- manifest_key/cli_version/created_by_token_id; sync_run_items.
-- previous_media_object_id/previous_logical_path; sessions.token_hash/
-- revoked_at.
--
-- Rows holding a removed enum value are deleted first: maintenance_jobs of
-- the retired legacy_derivative_cleanup type and sync_run_items recorded as
-- "update" or "keep" (sync writes only "upload" and "delete").
-- viewer_state loses subject_type (library_entry was its one remaining value)
-- and its subject_id now references library_entries with ON DELETE CASCADE;
-- rows for "collection" subjects or for entries already gone are deleted.
-- maintenance_jobs.progress loses its stale default (every scheduler writes
-- the job's initial progress), and the hard-wipe-only active index goes,
-- since the per-type one covers it. Hard-wipe progress written before the
-- Shutter-only architecture is rewritten to the shape the worker now reads:
-- the retired s3_derivatives phase becomes s3_originals, and a sweep token
-- from a retired listing prefix is dropped.
DELETE FROM "maintenance_jobs" WHERE "type"::text = 'legacy_derivative_cleanup';
--> statement-breakpoint
DELETE FROM "viewer_state" WHERE "subject_type"::text <> 'library_entry'
  OR NOT EXISTS (SELECT 1 FROM "library_entries" WHERE "library_entries"."id" = "viewer_state"."subject_id");
--> statement-breakpoint
DELETE FROM "sync_run_items" WHERE "action"::text IN ('update', 'keep');
--> statement-breakpoint
UPDATE "maintenance_jobs" SET "progress" = jsonb_set("progress", '{phase}', '"s3_originals"')
WHERE "type" = 'library_hard_wipe' AND "progress"->>'phase' = 's3_derivatives';
--> statement-breakpoint
UPDATE "maintenance_jobs" SET "progress" = ("progress" - 'orphanPrefix') || jsonb_build_object(
  'orphanContinuationToken',
  CASE WHEN coalesce("progress"->>'orphanPrefix', 'originals/') = 'originals/'
    THEN coalesce("progress"->'orphanContinuationToken', 'null'::jsonb)
    ELSE 'null'::jsonb END
)
WHERE "type" = 'library_hard_wipe' AND "progress" ? 'orphanPrefix';
--> statement-breakpoint
ALTER TABLE "library_entries" DROP CONSTRAINT "library_entries_sha256_lowercase";
--> statement-breakpoint
ALTER TABLE "library_entries" DROP CONSTRAINT "library_entries_source_ref_id_sources_id_fk";
--> statement-breakpoint
ALTER TABLE "library_entries" DROP CONSTRAINT "library_entries_last_sync_run_id_sync_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "media_objects" DROP CONSTRAINT "media_objects_created_by_sync_run_id_sync_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "sync_run_items" DROP CONSTRAINT "sync_run_items_previous_media_object_id_media_objects_id_fk";
--> statement-breakpoint
ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_source_id_sources_id_fk";
--> statement-breakpoint
ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_created_by_token_id_api_tokens_id_fk";
--> statement-breakpoint
DROP TABLE "api_tokens" CASCADE;
--> statement-breakpoint
DROP TABLE "collection_items" CASCADE;
--> statement-breakpoint
DROP TABLE "collections" CASCADE;
--> statement-breakpoint
DROP TABLE "favorites" CASCADE;
--> statement-breakpoint
DROP TABLE "sources" CASCADE;
--> statement-breakpoint
DROP INDEX "maintenance_jobs_active_hard_wipe_unique";
--> statement-breakpoint
DROP INDEX "sessions_token_hash_unique";
--> statement-breakpoint
DROP INDEX "sync_run_items_previous_media_object_id_idx";
--> statement-breakpoint
ALTER TABLE "maintenance_jobs" ALTER COLUMN "type" SET DATA TYPE text;
--> statement-breakpoint
DROP TYPE "public"."maintenance_job_type";
--> statement-breakpoint
CREATE TYPE "public"."maintenance_job_type" AS ENUM('library_hard_wipe', 'soft_deleted_purge', 'shutter_source_purge');
--> statement-breakpoint
ALTER TABLE "maintenance_jobs" ALTER COLUMN "type" SET DATA TYPE "public"."maintenance_job_type" USING "type"::"public"."maintenance_job_type";
--> statement-breakpoint
ALTER TABLE "sync_run_items" ALTER COLUMN "action" SET DATA TYPE text;
--> statement-breakpoint
DROP TYPE "public"."sync_action";
--> statement-breakpoint
CREATE TYPE "public"."sync_action" AS ENUM('upload', 'delete');
--> statement-breakpoint
ALTER TABLE "sync_run_items" ALTER COLUMN "action" SET DATA TYPE "public"."sync_action" USING "action"::"public"."sync_action";
--> statement-breakpoint
ALTER TABLE "maintenance_jobs" ALTER COLUMN "progress" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "folders" DROP COLUMN "entry_count";
--> statement-breakpoint
ALTER TABLE "folders" DROP COLUMN "folder_count";
--> statement-breakpoint
ALTER TABLE "folders" DROP COLUMN "depth";
--> statement-breakpoint
ALTER TABLE "library_entries" DROP COLUMN "source";
--> statement-breakpoint
ALTER TABLE "library_entries" DROP COLUMN "source_id";
--> statement-breakpoint
ALTER TABLE "library_entries" DROP COLUMN "source_ref_id";
--> statement-breakpoint
ALTER TABLE "library_entries" DROP COLUMN "last_sync_run_id";
--> statement-breakpoint
ALTER TABLE "library_entries" DROP COLUMN "hidden";
--> statement-breakpoint
ALTER TABLE "library_entries" DROP COLUMN "changed_at";
--> statement-breakpoint
ALTER TABLE "library_entries" DROP COLUMN "content_changed_at";
--> statement-breakpoint
ALTER TABLE "library_entries" DROP COLUMN "path_changed_at";
--> statement-breakpoint
ALTER TABLE "library_entries" DROP COLUMN "size";
--> statement-breakpoint
ALTER TABLE "library_entries" DROP COLUMN "sha256";
--> statement-breakpoint
ALTER TABLE "library_entries" DROP COLUMN "metadata";
--> statement-breakpoint
ALTER TABLE "library_entries" DROP COLUMN "last_seen_at";
--> statement-breakpoint
ALTER TABLE "media_objects" DROP COLUMN "width";
--> statement-breakpoint
ALTER TABLE "media_objects" DROP COLUMN "height";
--> statement-breakpoint
ALTER TABLE "media_objects" DROP COLUMN "duration_ms";
--> statement-breakpoint
ALTER TABLE "media_objects" DROP COLUMN "page_count";
--> statement-breakpoint
ALTER TABLE "media_objects" DROP COLUMN "storage_provider";
--> statement-breakpoint
ALTER TABLE "media_objects" DROP COLUMN "bucket";
--> statement-breakpoint
ALTER TABLE "media_objects" DROP COLUMN "etag";
--> statement-breakpoint
ALTER TABLE "media_objects" DROP COLUMN "created_by_sync_run_id";
--> statement-breakpoint
ALTER TABLE "media_objects" DROP COLUMN "metadata";
--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "token_hash";
--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "revoked_at";
--> statement-breakpoint
ALTER TABLE "sync_run_items" DROP COLUMN "previous_media_object_id";
--> statement-breakpoint
ALTER TABLE "sync_run_items" DROP COLUMN "previous_logical_path";
--> statement-breakpoint
ALTER TABLE "sync_runs" DROP COLUMN "source_id";
--> statement-breakpoint
ALTER TABLE "sync_runs" DROP COLUMN "manifest_key";
--> statement-breakpoint
ALTER TABLE "sync_runs" DROP COLUMN "cli_version";
--> statement-breakpoint
ALTER TABLE "sync_runs" DROP COLUMN "created_by_token_id";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "password_hash";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "role";
--> statement-breakpoint
ALTER TABLE "viewer_state" DROP CONSTRAINT "viewer_state_user_id_subject_id_subject_type_pk";
--> statement-breakpoint
ALTER TABLE "viewer_state" DROP COLUMN "subject_type";
--> statement-breakpoint
ALTER TABLE "viewer_state" ADD CONSTRAINT "viewer_state_user_id_subject_id_pk" PRIMARY KEY("user_id","subject_id");
--> statement-breakpoint
ALTER TABLE "viewer_state" ADD CONSTRAINT "viewer_state_subject_id_library_entries_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."library_entries"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
DROP TYPE "public"."collection_type";
--> statement-breakpoint
DROP TYPE "public"."source_type";
--> statement-breakpoint
DROP TYPE "public"."subject_type";
