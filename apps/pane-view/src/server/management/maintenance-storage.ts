import { deleteStoredObjectsBatch, type S3CommandStorage } from "@latch-works/media-storage";
import { getPaneViewStorageClient } from "../media/storage-client";

const deleteConcurrency = 8;

/**
 * Deletes a maintenance batch from object storage, failing on the first
 * error so the job's cursor stays retry-safe. Storage defaults to the client
 * request handlers share.
 */
export async function deleteMaintenanceObjects(
  keys: string[],
  storage: S3CommandStorage = getPaneViewStorageClient(),
): Promise<{ deleted: number }> {
  let firstError: Error | undefined;

  const result = await deleteStoredObjectsBatch({
    keys,
    maxConcurrent: deleteConcurrency,
    onError: (error) => {
      firstError ??= error;
    },
    storage,
  });

  if (result.errors > 0) {
    const reason = firstError?.message ?? "Unknown object storage error";
    throw new Error(`${result.errors} object storage deletes failed: ${reason}`);
  }

  return { deleted: result.deleted };
}
