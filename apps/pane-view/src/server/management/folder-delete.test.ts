import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  committedMutations: [] as string[],
  failureAt: 0,
  failureError: null as Error | null,
  returningMock: vi.fn(),
  returningCallCount: 0,
  setMock: vi.fn(),
  transactionMock: vi.fn(),
  txUpdateMock: vi.fn(),
  updateMock: vi.fn(),
  whereMock: vi.fn(),
}));

vi.mock("../db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([]),
      })),
    })),
    update: mocks.updateMock,
    transaction: mocks.transactionMock,
  },
}));

import { softDeleteFolderSubtree } from "./folder-delete";

describe("softDeleteFolderSubtree", () => {
  beforeEach(() => {
    mocks.updateMock.mockReset();
    mocks.setMock.mockReset();
    mocks.whereMock.mockReset();
    mocks.returningMock.mockReset();
    mocks.transactionMock.mockReset();
    mocks.txUpdateMock.mockReset();
    mocks.committedMutations.length = 0;
    mocks.failureAt = 0;
    mocks.failureError = null;
    mocks.returningCallCount = 0;

    mocks.updateMock.mockReturnValue({ set: mocks.setMock });
    mocks.setMock.mockReturnValue({ where: mocks.whereMock });
    mocks.whereMock.mockReturnValue({ returning: mocks.returningMock });
    mocks.transactionMock.mockImplementation(async (callback) => {
      const stagedMutations: string[] = [];
      mocks.returningMock.mockImplementation(async () => {
        mocks.returningCallCount += 1;
        if (mocks.failureError && mocks.returningCallCount === mocks.failureAt) {
          throw mocks.failureError;
        }
        stagedMutations.push("mutation");
        return [{ id: "row-1" }];
      });

      const result = await callback({ update: mocks.txUpdateMock });
      mocks.committedMutations.push(...stagedMutations);
      return result;
    });
    mocks.txUpdateMock.mockReturnValue({ set: mocks.setMock });
  });

  it("rejects deleting the archive root", async () => {
    await expect(softDeleteFolderSubtree({ folderPaths: [""] })).rejects.toThrow(
      "Cannot delete the archive root",
    );
  });

  it("rejects folder paths with parent segments", async () => {
    await expect(softDeleteFolderSubtree({ folderPaths: ["photos/../other"] })).rejects.toThrow(
      "Folder path must not contain '..' segments.",
    );
  });

  it("rejects empty folder selection", async () => {
    await expect(softDeleteFolderSubtree({ folderPaths: [] })).rejects.toThrow(
      "Select at least one folder",
    );
  });

  it("soft-deletes entries and folders in one transaction", async () => {
    const results = await softDeleteFolderSubtree({
      folderPaths: ["photos/2026/", "photos/2026", "photos/2025"],
    });

    expect(results).toEqual([
      {
        entriesDeleted: 1,
        foldersDeleted: 1,
        path: "photos/2026",
      },
      {
        entriesDeleted: 1,
        foldersDeleted: 1,
        path: "photos/2025",
      },
    ]);
    expect(mocks.transactionMock).toHaveBeenCalledTimes(1);
    expect(mocks.updateMock).not.toHaveBeenCalled();
    expect(mocks.txUpdateMock).toHaveBeenCalledTimes(4);
    expect(mocks.setMock).toHaveBeenCalledWith({ deletedAt: expect.any(Date) });
    expect(mocks.setMock.mock.calls.map(([values]) => values.deletedAt)).toEqual([
      mocks.setMock.mock.calls[0]?.[0].deletedAt,
      mocks.setMock.mock.calls[0]?.[0].deletedAt,
      mocks.setMock.mock.calls[0]?.[0].deletedAt,
      mocks.setMock.mock.calls[0]?.[0].deletedAt,
    ]);
    expect(mocks.committedMutations).toHaveLength(4);
  });

  it("rolls back when the folder update fails", async () => {
    const error = new Error("folder update failed");
    mocks.failureAt = 2;
    mocks.failureError = error;

    await expect(softDeleteFolderSubtree({ folderPaths: ["photos/2026"] })).rejects.toThrow(error);

    expect(mocks.committedMutations).toEqual([]);
  });

  it("rolls back all roots when a later folder update fails", async () => {
    const error = new Error("second root folder update failed");
    mocks.failureAt = 4;
    mocks.failureError = error;

    await expect(
      softDeleteFolderSubtree({ folderPaths: ["photos/2026", "photos/2025"] }),
    ).rejects.toThrow(error);

    expect(mocks.committedMutations).toEqual([]);
  });
});
