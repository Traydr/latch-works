import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createStorage: vi.fn(() => ({ id: "shared-storage" })),
  deleteBatch: vi.fn(),
}));

vi.mock("@latch-works/media-storage", () => ({
  deleteStoredObjectsBatch: mocks.deleteBatch,
}));

vi.mock("../media/storage-client", () => ({
  createPaneViewStorageClient: mocks.createStorage,
}));

describe("deleteMaintenanceObjects", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.createStorage.mockClear();
    mocks.deleteBatch.mockReset();
  });

  it("reuses one storage client and caps delete concurrency", async () => {
    mocks.deleteBatch.mockResolvedValue({ deleted: 2, errors: 0 });
    const { deleteMaintenanceObjects } = await import("./maintenance-storage");

    await deleteMaintenanceObjects(["originals/a", "originals/b"]);
    await deleteMaintenanceObjects(["originals/c"]);

    expect(mocks.createStorage).toHaveBeenCalledOnce();
    expect(mocks.deleteBatch).toHaveBeenCalledTimes(2);
    expect(mocks.deleteBatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ maxConcurrent: 8, storage: { id: "shared-storage" } }),
    );
  });

  it("fails the job with the first concrete storage error", async () => {
    mocks.deleteBatch.mockImplementation(async ({ onError }) => {
      onError(new Error("Access denied by object storage"), "originals/a");
      return { deleted: 0, errors: 2 };
    });
    const { deleteMaintenanceObjects } = await import("./maintenance-storage");

    await expect(deleteMaintenanceObjects(["originals/a", "originals/b"])).rejects.toThrow(
      "2 object storage deletes failed: Access denied by object storage",
    );
  });
});
