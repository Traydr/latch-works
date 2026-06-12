import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertWebSessionAuthorized,
  readLibrarySnapshotRequest,
} from "./library-service";

vi.mock("../../server/auth/web-session", () => ({
  isCurrentWebSessionValid: vi.fn(),
}));

vi.mock("../../server/library/repository", () => ({
  readDatabaseLibrarySnapshot: vi.fn(),
}));

import { isCurrentWebSessionValid } from "../../server/auth/web-session";
import { readDatabaseLibrarySnapshot } from "../../server/library/repository";

describe("library snapshot auth", () => {
  beforeEach(() => {
    vi.mocked(isCurrentWebSessionValid).mockReset();
    vi.mocked(readDatabaseLibrarySnapshot).mockReset();
  });

  it("rejects unauthenticated snapshot requests", async () => {
    vi.mocked(isCurrentWebSessionValid).mockResolvedValue(false);

    await expect(assertWebSessionAuthorized()).rejects.toThrow("Unauthorized");
    expect(readDatabaseLibrarySnapshot).not.toHaveBeenCalled();
  });

  it("loads snapshots for authenticated requests", async () => {
    vi.mocked(isCurrentWebSessionValid).mockResolvedValue(true);
    vi.mocked(readDatabaseLibrarySnapshot).mockResolvedValue({
      allFolders: [],
      folders: [],
      media: [],
      roots: ["photos"],
    });

    const snapshot = await readLibrarySnapshotRequest({ path: "photos" });

    expect(readDatabaseLibrarySnapshot).toHaveBeenCalledWith({
      currentPath: "photos",
      includeAllFolders: false,
      limit: undefined,
      offset: 0,
      query: undefined,
      recursive: false,
    });
    expect(snapshot.currentPath).toBe("photos");
    expect(snapshot.roots).toEqual(["photos"]);
  });
});
