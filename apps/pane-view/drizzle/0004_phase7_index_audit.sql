CREATE INDEX IF NOT EXISTS "folders_deleted_at_idx" ON "folders" USING btree ("deleted_at");
CREATE INDEX IF NOT EXISTS "library_entries_deleted_at_idx" ON "library_entries" USING btree ("deleted_at");
CREATE INDEX IF NOT EXISTS "thumbnails_status_idx" ON "thumbnails" USING btree ("media_object_id","size","status");
