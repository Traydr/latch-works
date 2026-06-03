UPDATE "folders" AS child
SET
  "parent_id" = parent.id,
  "depth" = COALESCE(NULLIF(child.depth, 0), array_length(string_to_array(child.path, '/'), 1))
FROM "folders" AS parent
WHERE child.parent_path = parent.path
  AND child.parent_id IS NULL;
