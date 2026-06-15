import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteMock: vi.fn(),
  deleteStoredObject: vi.fn(),
  selectMock: vi.fn(),
}));

vi.mock("../db", () => ({
  db: {
    delete: mocks.deleteMock,
    select: mocks.selectMock,
  },
}));

vi.mock("../media/storage-client", () => ({
  createPaneViewStorageClient: vi.fn(() => ({})),
}));

vi.mock("@latch-works/media-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@latch-works/media-storage")>();
  return {
    ...actual,
    deleteStoredObject: mocks.deleteStoredObject,
  };
});

import { purgeAllThumbnailDerivatives } from "../media/derivative-service";

describe("purgeAllThumbnailDerivatives", () => {
  beforeEach(() => {
    mocks.selectMock.mockReset();
    mocks.deleteMock.mockReset();
    mocks.deleteStoredObject.mockReset();

    mocks.deleteStoredObject.mockResolvedValue(undefined);
    mocks.deleteMock.mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("deletes thumbnail rows and storage objects in batches", async () => {
    const firstBatch = [{ mediaObjectId: "obj-1", objectKey: "thumbnails/a.webp", size: 320 }];

    mocks.selectMock
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(firstBatch),
        }),
      })
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      });

    const result = await purgeAllThumbnailDerivatives();

    expect(result).toEqual({ deletedRows: 1, s3Errors: 0 });
    expect(mocks.deleteStoredObject).toHaveBeenCalledWith({
      key: "thumbnails/a.webp",
      storage: {},
    });
  });
});
