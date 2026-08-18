import type { S3StorageClient } from "@latch-works/media-storage";
import { describe, expect, it, vi } from "vitest";

import {
  createMaintenanceStorage,
  type MaintenanceStorageDependencies,
} from "./maintenance-storage";

/** Only `bucket` is read by the assertions; the client is never sent a command. */
function fakeStorageClient(bucket: string): S3StorageClient {
  // SAFETY: createMaintenanceStorage only passes the client through to
  // deleteStoredObjectsBatch, which is faked here, so no S3Client method is
  // ever called on it.
  return { bucket, client: {} as S3StorageClient["client"] };
}

describe("maintenance storage", () => {
  it("reuses one storage client and caps delete concurrency", async () => {
    const createStorageClient = vi.fn(() => fakeStorageClient("shared-storage"));
    const deleteStoredObjectsBatch = vi.fn(async () => ({ deleted: 2, errors: 0 }));
    const storage = createMaintenanceStorage({ createStorageClient, deleteStoredObjectsBatch });

    await storage.deleteObjects(["originals/a", "originals/b"]);
    await storage.deleteObjects(["originals/c"]);

    expect(createStorageClient).toHaveBeenCalledOnce();
    expect(deleteStoredObjectsBatch).toHaveBeenCalledTimes(2);
    expect(deleteStoredObjectsBatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        maxConcurrent: 8,
        storage: expect.objectContaining({ bucket: "shared-storage" }),
      }),
    );
  });

  it("fails the job with the first concrete storage error", async () => {
    const dependencies: MaintenanceStorageDependencies = {
      createStorageClient: () => fakeStorageClient("shared-storage"),
      deleteStoredObjectsBatch: async ({ onError }) => {
        onError?.(new Error("Access denied by object storage"), "originals/a");
        onError?.(new Error("Throttled"), "originals/b");
        return { deleted: 0, errors: 2 };
      },
    };

    await expect(
      createMaintenanceStorage(dependencies).deleteObjects(["originals/a", "originals/b"]),
    ).rejects.toThrow("2 object storage deletes failed: Access denied by object storage");
  });
});
