import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteBatch: vi.fn(),
  listSummaries: vi.fn(),
}));

vi.mock("@latch-works/media-storage", () => ({
  deleteStoredObjectsBatch: mocks.deleteBatch,
  listStoredObjectSummariesByPrefix: mocks.listSummaries,
}));
vi.mock("../media/storage-client", () => ({ createPaneViewStorageClient: vi.fn(() => ({})) }));

import {
  deleteLegacyDerivativeBatch,
  readLegacyDerivativeInventory,
} from "./legacy-derivative-storage";

describe("legacy derivative storage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("inventories only the allowlisted prefixes across pages", async () => {
    mocks.listSummaries
      .mockResolvedValueOnce({
        nextContinuationToken: "thumb-next",
        objects: [{ key: "thumbnails/a", size: 10 }],
      })
      .mockResolvedValueOnce({
        nextContinuationToken: undefined,
        objects: [{ key: "thumbnails/b", size: 20 }],
      })
      .mockResolvedValueOnce({
        nextContinuationToken: undefined,
        objects: [{ key: "previews/a", size: 30 }],
      });

    await expect(readLegacyDerivativeInventory()).resolves.toEqual({
      prefixes: [
        { bytes: 30, count: 2, prefix: "thumbnails/" },
        { bytes: 30, count: 1, prefix: "previews/" },
      ],
      totalBytes: 60,
      totalCount: 3,
    });
    expect(mocks.listSummaries.mock.calls.map(([input]) => input.prefix)).toEqual([
      "thumbnails/",
      "thumbnails/",
      "previews/",
    ]);
  });

  it("counts bytes only for successfully deleted objects and caps concurrency", async () => {
    mocks.deleteBatch.mockImplementation(async ({ onError }) => {
      onError(new Error("failed"), "previews/b");
      return { deleted: 1, errors: 1 };
    });
    await expect(
      deleteLegacyDerivativeBatch([
        { key: "previews/a", size: 10 },
        { key: "previews/b", size: 20 },
      ]),
    ).resolves.toEqual({ deletedBytes: 10, deletedCount: 1, errorCount: 1 });
    expect(mocks.deleteBatch).toHaveBeenCalledWith(expect.objectContaining({ maxConcurrent: 10 }));
  });
});
