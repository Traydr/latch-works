import { deleteStoredObjectsBatch, type S3StorageClient } from "@latch-works/media-storage";
import { createPaneViewStorageClient } from "../media/storage-client";

const deleteConcurrency = 8;

let storageClient: S3StorageClient | undefined;

export function getMaintenanceStorageClient(): S3StorageClient {
  storageClient ??= createPaneViewStorageClient();
  return storageClient;
}

export async function deleteMaintenanceObjects(keys: string[]): Promise<{ deleted: number }> {
  let firstError: unknown;
  const result = await deleteStoredObjectsBatch({
    keys,
    maxConcurrent: deleteConcurrency,
    onError: (error) => {
      firstError ??= error;
    },
    storage: getMaintenanceStorageClient(),
  });

  if (result.errors > 0) {
    const reason =
      firstError instanceof Error
        ? firstError.message
        : firstError === undefined
          ? "Unknown object storage error"
          : String(firstError);
    throw new Error(`${result.errors} object storage deletes failed: ${reason}`);
  }

  return { deleted: result.deleted };
}
