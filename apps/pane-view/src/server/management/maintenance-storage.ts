import {
  deleteStoredObjectsBatch,
  type S3CommandStorage,
  type S3StorageClient,
} from "@latch-works/media-storage";
import { createPaneViewStorageClient } from "../media/storage-client";

const deleteConcurrency = 8;

/** The object storage calls maintenance jobs make; the default wires the real bucket. */
export interface MaintenanceStorageDependencies {
  createStorageClient(): S3StorageClient;
  deleteStoredObjectsBatch(request: {
    keys: string[];
    maxConcurrent?: number;
    onError?: (error: Error, key: string) => void;
    storage: S3CommandStorage;
  }): Promise<{ deleted: number; errors: number }>;
}

const defaultMaintenanceStorageDependencies: MaintenanceStorageDependencies = {
  createStorageClient: createPaneViewStorageClient,
  deleteStoredObjectsBatch,
};

export interface MaintenanceStorage {
  /** The one client every maintenance job shares; created on first use. */
  getStorageClient(): S3StorageClient;
  deleteObjects(keys: string[]): Promise<{ deleted: number }>;
}

export function createMaintenanceStorage(
  dependencies: MaintenanceStorageDependencies = defaultMaintenanceStorageDependencies,
): MaintenanceStorage {
  let storageClient: S3StorageClient | undefined;

  function getStorageClient(): S3StorageClient {
    storageClient ??= dependencies.createStorageClient();
    return storageClient;
  }

  return {
    getStorageClient,

    async deleteObjects(keys) {
      let firstError: Error | undefined;
      const result = await dependencies.deleteStoredObjectsBatch({
        keys,
        maxConcurrent: deleteConcurrency,
        onError: (error) => {
          firstError ??= error;
        },
        storage: getStorageClient(),
      });

      if (result.errors > 0) {
        const reason = firstError?.message ?? "Unknown object storage error";
        throw new Error(`${result.errors} object storage deletes failed: ${reason}`);
      }

      return { deleted: result.deleted };
    },
  };
}

const sharedMaintenanceStorage = createMaintenanceStorage();

export function getMaintenanceStorageClient(): S3StorageClient {
  return sharedMaintenanceStorage.getStorageClient();
}

export function deleteMaintenanceObjects(keys: string[]): Promise<{ deleted: number }> {
  return sharedMaintenanceStorage.deleteObjects(keys);
}
