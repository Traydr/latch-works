-- 0024_media_objects_has_audio: whether a video has audio, for the gallery's
-- "videos with audio" filter.
--
-- Additive and nullable: existing rows read null (unknown) until a Lockstep or
-- Oriel push probes the video and reports it, either with the upload or through
-- POST /api/sync/media-facts for videos synced before this column existed.
ALTER TABLE "media_objects" ADD COLUMN "has_audio" boolean;
