import {
  createS3StorageClient,
  deleteStoredObjectsBatch,
  listStoredObjectsByPrefix,
  readS3StorageConfig,
} from "@latch-works/media-storage";
import postgres from "postgres";

const batchSize = 500;
const prefixes = ["thumbnails/", "previews/"] as const;

async function deleteKeys(keys: string[], storage: ReturnType<typeof createS3StorageClient>) {
  const result = await deleteStoredObjectsBatch({ keys, storage });
  if (result.errors > 0) throw new Error(`Failed to delete ${result.errors} derivative objects`);
  return result.deleted;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const storageConfig = readS3StorageConfig(process.env);
  if (!databaseUrl || !storageConfig) {
    throw new Error("DATABASE_URL and complete S3 configuration are required");
  }

  const sql = postgres(databaseUrl, { max: 1 });
  const storage = createS3StorageClient(storageConfig);
  let deleted = 0;

  try {
    while (true) {
      const rows = await sql<{ media_object_id: string; object_key: string; size: number }[]>`
        SELECT media_object_id, object_key, size FROM thumbnails LIMIT ${batchSize}
      `;
      if (rows.length === 0) break;
      deleted += await deleteKeys(
        rows.map((row) => row.object_key),
        storage,
      );
      await sql.begin(async (transaction) => {
        for (const row of rows) {
          await transaction`
            DELETE FROM thumbnails
            WHERE media_object_id = ${row.media_object_id} AND size = ${row.size}
          `;
        }
      });
    }

    for (const prefix of prefixes) {
      while (true) {
        const page = await listStoredObjectsByPrefix({
          limit: batchSize,
          prefix,
          storage,
        });
        if (page.keys.length === 0) break;
        deleted += await deleteKeys(page.keys, storage);
      }
    }
  } finally {
    await sql.end();
  }

  console.log(JSON.stringify({ deleted, errors: 0 }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
