import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  returningMock: vi.fn(),
  setMock: vi.fn(),
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
  },
}));

import { softDeleteFolderSubtree } from "./folder-delete";

describe("softDeleteFolderSubtree", () => {
  beforeEach(() => {
    mocks.updateMock.mockReset();
    mocks.setMock.mockReset();
    mocks.whereMock.mockReset();
    mocks.returningMock.mockReset();

    mocks.updateMock.mockReturnValue({ set: mocks.setMock });
    mocks.setMock.mockReturnValue({ where: mocks.whereMock });
    mocks.whereMock.mockReturnValue({ returning: mocks.returningMock });
    mocks.returningMock.mockResolvedValue([{ id: "row-1" }]);
  });

  it("rejects deleting the archive root", async () => {
    await expect(softDeleteFolderSubtree({ folderPaths: [""] })).rejects.toThrow(
      "Cannot delete the archive root",
    );
  });

  it("rejects empty folder selection", async () => {
    await expect(softDeleteFolderSubtree({ folderPaths: [] })).rejects.toThrow(
      "Select at least one folder",
    );
  });

  it("soft-deletes entries and folders for each selected path", async () => {
    const results = await softDeleteFolderSubtree({ folderPaths: ["sfw/patreon"] });

    expect(results).toEqual([
      {
        entriesDeleted: 1,
        foldersDeleted: 1,
        path: "sfw/patreon",
      },
    ]);
    expect(mocks.updateMock).toHaveBeenCalledTimes(2);
    expect(mocks.setMock).toHaveBeenCalledWith({ deletedAt: expect.any(Date) });
  });
});
