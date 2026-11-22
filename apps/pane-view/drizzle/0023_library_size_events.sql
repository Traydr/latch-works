-- 0023_library_size_events: a ledger of how the size of live entries changes.
--
-- The stats chart summed media objects by created date, so it could only grow:
-- a re-encode showed as new bytes, and the purge that later removed the old
-- originals moved the whole curve down instead of showing a drop on the day.
-- From here on, a trigger on library_entries writes one row per change to a
-- live entry's size: added, replaced (new content at the same path), removed
-- (soft-deleted or deleted) and restored. Every write path goes through it,
-- including the ones the app adds later.
--
-- Data-writing. Seeds one "added" row per live entry at its first_seen_at with
-- the size of its current content, so the ledger's sum starts equal to the size
-- of live entries. History before this migration is that estimate; it is exact
-- from here on.
CREATE TYPE "public"."library_size_event_kind" AS ENUM('added', 'replaced', 'removed', 'restored');--> statement-breakpoint
CREATE TABLE "library_size_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "library_size_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"logical_path" text NOT NULL,
	"media_object_id" uuid NOT NULL,
	"kind" "library_size_event_kind" NOT NULL,
	"bytes_delta" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "library_size_events_occurred_at_idx" ON "library_size_events" USING btree ("occurred_at");
--> statement-breakpoint
INSERT INTO "library_size_events" ("occurred_at", "logical_path", "media_object_id", "kind", "bytes_delta")
SELECT "entry"."first_seen_at", "entry"."logical_path", "entry"."media_object_id", 'added', "object"."size"
FROM "library_entries" AS "entry"
INNER JOIN "media_objects" AS "object" ON "object"."id" = "entry"."media_object_id"
WHERE "entry"."deleted_at" IS NULL;--> statement-breakpoint
-- A live entry's bytes are its media object's size; a soft-deleted entry has none.
-- Media sizes never change ((sha256, size) is the media key), so reading the size
-- when the entry changes is exact. A hard delete of a live entry cascading from its
-- media object would read no size, but purges only take media no live entry uses.
CREATE FUNCTION "record_library_size_event"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_bytes bigint := 0;
  new_bytes bigint := 0;
  event_kind "library_size_event_kind";
  event_entry "library_entries";
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.deleted_at IS NOT NULL THEN
      RETURN NULL;
    END IF;
    event_kind := 'added';
    event_entry := NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.deleted_at IS NOT NULL THEN
      RETURN NULL;
    END IF;
    event_kind := 'removed';
    event_entry := OLD;
  ELSIF OLD.deleted_at IS NULL AND NEW.deleted_at IS NULL THEN
    IF OLD.media_object_id = NEW.media_object_id THEN
      RETURN NULL;
    END IF;
    event_kind := 'replaced';
    event_entry := NEW;
  ELSIF OLD.deleted_at IS NULL THEN
    event_kind := 'removed';
    event_entry := OLD;
  ELSIF NEW.deleted_at IS NULL THEN
    event_kind := 'restored';
    event_entry := NEW;
  ELSE
    RETURN NULL;
  END IF;

  IF event_kind IN ('replaced', 'removed') THEN
    SELECT coalesce(max(size), 0) INTO old_bytes FROM media_objects WHERE id = OLD.media_object_id;
  END IF;

  IF event_kind IN ('added', 'replaced', 'restored') THEN
    SELECT coalesce(max(size), 0) INTO new_bytes FROM media_objects WHERE id = NEW.media_object_id;
  END IF;

  INSERT INTO library_size_events (logical_path, media_object_id, kind, bytes_delta)
  VALUES (event_entry.logical_path, event_entry.media_object_id, event_kind, new_bytes - old_bytes);

  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "library_entries_size_events"
AFTER INSERT OR DELETE OR UPDATE OF "media_object_id", "deleted_at" ON "library_entries"
FOR EACH ROW EXECUTE FUNCTION "record_library_size_event"();
