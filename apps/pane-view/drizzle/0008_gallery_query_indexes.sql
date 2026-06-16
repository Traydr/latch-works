-- Trigram indexes for gallery recursive path prefix and substring search queries.
-- Drizzle schema does not model pg_trgm GIN indexes cleanly, so this migration is manual.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "library_entries_logical_path_trgm_idx"
  ON "library_entries" USING gin ("logical_path" gin_trgm_ops)
  WHERE "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "library_entries_filename_trgm_idx"
  ON "library_entries" USING gin ("filename" gin_trgm_ops)
  WHERE "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "folders_path_trgm_idx"
  ON "folders" USING gin ("path" gin_trgm_ops)
  WHERE "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "folders_name_trgm_idx"
  ON "folders" USING gin ("name" gin_trgm_ops)
  WHERE "deleted_at" IS NULL;
