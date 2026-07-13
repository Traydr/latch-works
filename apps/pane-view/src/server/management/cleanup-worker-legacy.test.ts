import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteBatch: vi.fn(),
  listBatch: vi.fn(),
  set: vi.fn(),
  update: vi.fn(),
  where: vi.fn(),
}));

vi.mock("../db", () => ({
  db: {
    update: mocks.update,
  },
}));
vi.mock("./legacy-derivative-storage", () => ({
  deleteLegacyDerivativeBatch: mocks.deleteBatch,
  legacyDerivativePrefixes: ["thumbnails/", "previews/"],
  readLegacyDerivativeBatch: mocks.listBatch,
}));
vi.mock("../media/shutter-client", () => ({ purgeShutterSource: vi.fn() }));
vi.mock("../media/storage-client", () => ({ createPaneViewStorageClient: vi.fn() }));

import { cleanupWorkerTestHooks } from "./cleanup-worker";

const progress = {
  consecutiveNoProgressCount: 0,
  errorCount: 0,
  phase: "legacy_prefixes" as const,
  prefix: "thumbnails/" as const,
  processedBytes: 0,
  processedCount: 0,
};

describe("legacy derivative cleanup worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.where.mockResolvedValue(undefined);
    mocks.set.mockReturnValue({ where: mocks.where });
    mocks.update.mockReturnValue({ set: mocks.set });
  });

  it("advances between only the two allowlisted prefixes", async () => {
    mocks.listBatch.mockResolvedValue([]);

    await expect(
      cleanupWorkerTestHooks.processLegacyDerivativeCleanupBatch("job-1", progress),
    ).resolves.toBe(true);
    expect(mocks.set).toHaveBeenCalledWith({
      progress: expect.objectContaining({ prefix: "previews/" }),
    });
  });

  it("fails after a third consecutive batch makes no deletion progress", async () => {
    mocks.listBatch.mockResolvedValue([{ key: "thumbnails/a", size: 10 }]);
    mocks.deleteBatch.mockResolvedValue({ deletedBytes: 0, deletedCount: 0, errorCount: 1 });

    await expect(
      cleanupWorkerTestHooks.processLegacyDerivativeCleanupBatch("job-1", {
        ...progress,
        consecutiveNoProgressCount: 2,
      }),
    ).resolves.toBe(false);
    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        progress: expect.objectContaining({ consecutiveNoProgressCount: 3, errorCount: 1 }),
      }),
    );
  });

  it("completes only after the previews prefix is empty", async () => {
    mocks.listBatch.mockResolvedValue([]);

    await expect(
      cleanupWorkerTestHooks.processLegacyDerivativeCleanupBatch("job-1", {
        ...progress,
        prefix: "previews/",
      }),
    ).resolves.toBe(false);
    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "completed",
        progress: expect.objectContaining({ phase: "completed" }),
      }),
    );
  });
});
