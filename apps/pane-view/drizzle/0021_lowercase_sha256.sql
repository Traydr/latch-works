-- 0021_lowercase_sha256: one spelling per content hash.
--
-- Sync lowercases SHA-256 values at validation, but rows written before that
-- could hold uppercase or mixed-case hex. Two spellings of one hash made two
-- media rows naming the same original, and queue checks that compare hashes
-- as text missed each other. This migration rewrites stored hashes to
-- lowercase and then forbids any other spelling with CHECK constraints.
--
-- Data-mutating. Where lowercasing makes two media_objects rows collide on
-- (sha256, size), the row already in lowercase is kept (otherwise the oldest),
-- every library_entries and sync_run_items reference is repointed to it, and
-- the other row is deleted. Colliding shutter_source_cleanup rows are merged
-- into one; it stays unpurged if any of them was unpurged. When every stored
-- hash is already lowercase, each statement matches no rows and only the
-- constraints are added.
CREATE TEMPORARY TABLE "media_object_sha256_merge" AS
SELECT "id" AS "duplicate_id", "keeper_id"
FROM (
  SELECT
    "id",
    first_value("id") OVER (
      PARTITION BY lower("sha256"), "size"
      ORDER BY ("sha256" = lower("sha256")) DESC, "created_at", "id"
    ) AS "keeper_id"
  FROM "media_objects"
) AS "ranked"
WHERE "id" <> "keeper_id";--> statement-breakpoint
UPDATE "library_entries" SET "media_object_id" = "merge"."keeper_id"
FROM "media_object_sha256_merge" AS "merge"
WHERE "library_entries"."media_object_id" = "merge"."duplicate_id";--> statement-breakpoint
UPDATE "sync_run_items" SET "media_object_id" = "merge"."keeper_id"
FROM "media_object_sha256_merge" AS "merge"
WHERE "sync_run_items"."media_object_id" = "merge"."duplicate_id";--> statement-breakpoint
UPDATE "sync_run_items" SET "previous_media_object_id" = "merge"."keeper_id"
FROM "media_object_sha256_merge" AS "merge"
WHERE "sync_run_items"."previous_media_object_id" = "merge"."duplicate_id";--> statement-breakpoint
DELETE FROM "media_objects"
USING "media_object_sha256_merge" AS "merge"
WHERE "media_objects"."id" = "merge"."duplicate_id";--> statement-breakpoint
DROP TABLE "media_object_sha256_merge";--> statement-breakpoint
UPDATE "media_objects" SET "sha256" = lower("sha256") WHERE "sha256" <> lower("sha256");--> statement-breakpoint
UPDATE "library_entries" SET "sha256" = lower("sha256") WHERE "sha256" <> lower("sha256");--> statement-breakpoint
CREATE TEMPORARY TABLE "shutter_source_cleanup_sha256_merge" AS
SELECT
  lower("sha256") AS "sha256",
  (array_agg("object_key" ORDER BY "purged_at" IS NULL DESC, "queued_at" DESC)
    FILTER (WHERE "object_key" IS NOT NULL))[1] AS "object_key",
  min("queued_at") AS "queued_at",
  CASE WHEN bool_or("purged_at" IS NULL) THEN NULL ELSE max("purged_at") END AS "purged_at"
FROM "shutter_source_cleanup"
GROUP BY lower("sha256")
HAVING bool_or("sha256" <> lower("sha256"));--> statement-breakpoint
DELETE FROM "shutter_source_cleanup"
WHERE lower("sha256") IN (SELECT "sha256" FROM "shutter_source_cleanup_sha256_merge");--> statement-breakpoint
INSERT INTO "shutter_source_cleanup" ("sha256", "object_key", "queued_at", "purged_at")
SELECT "sha256", "object_key", "queued_at", "purged_at"
FROM "shutter_source_cleanup_sha256_merge";--> statement-breakpoint
DROP TABLE "shutter_source_cleanup_sha256_merge";--> statement-breakpoint
ALTER TABLE "library_entries" ADD CONSTRAINT "library_entries_sha256_lowercase" CHECK ("library_entries"."sha256" = lower("library_entries"."sha256"));--> statement-breakpoint
ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_sha256_lowercase" CHECK ("media_objects"."sha256" = lower("media_objects"."sha256"));--> statement-breakpoint
ALTER TABLE "shutter_source_cleanup" ADD CONSTRAINT "shutter_source_cleanup_sha256_lowercase" CHECK ("shutter_source_cleanup"."sha256" = lower("shutter_source_cleanup"."sha256"));
