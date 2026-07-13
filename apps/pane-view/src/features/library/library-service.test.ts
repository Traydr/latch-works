import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertWebSessionAuthorized,
  DEFAULT_MEDIA_PAGE_LIMIT,
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

const emptyMediaPage = {
  hasMore: false,
  limit: DEFAULT_MEDIA_PAGE_LIMIT,
  nextOffset: null,
  offset: 0,
};

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
      mediaPage: emptyMediaPage,
      roots: ["photos"],
    });

    const snapshot = await readLibrarySnapshotRequest({ path: "photos" });

    expect(readDatabaseLibrarySnapshot).toHaveBeenCalledWith({
      currentPath: "photos",
      includeAllFolders: false,
      limit: DEFAULT_MEDIA_PAGE_LIMIT,
      offset: 0,
      query: undefined,
      recursive: false,
    });
    expect(snapshot.currentPath).toBe("photos");
    expect(snapshot.mediaPage).toEqual(emptyMediaPage);
    expect(snapshot.roots).toEqual(["photos"]);
  });

  it("includes all folders for initial comic snapshots", async () => {
    vi.mocked(readDatabaseLibrarySnapshot).mockResolvedValue({
      allFolders: [],
      folders: [],
      media: [],
      mediaPage: emptyMediaPage,
      roots: [],
    });

    await readLibrarySnapshotRequest({ comicMode: true, path: "photos" });

    expect(readDatabaseLibrarySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        includeAllFolders: true,
        recursive: true,
      }),
    );
  });
});

describe("library snapshot paging", () => {
  beforeEach(() => {
    vi.mocked(readDatabaseLibrarySnapshot).mockReset();
    vi.mocked(readDatabaseLibrarySnapshot).mockResolvedValue({
      allFolders: [],
      folders: [],
      media: [],
      mediaPage: emptyMediaPage,
      roots: [],
    });
  });

  it("passes media offset and default limit for non-search requests", async () => {
    await readLibrarySnapshotRequest({ mediaOffset: 500, path: "photos" });

    expect(readDatabaseLibrarySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: DEFAULT_MEDIA_PAGE_LIMIT,
        offset: 500,
        query: undefined,
      }),
    );
  });

  it("omits all folders for paged comic snapshots when explicitly requested", async () => {
    await readLibrarySnapshotRequest({
      comicMode: true,
      includeAllFolders: false,
      mediaOffset: 500,
      path: "photos",
    });

    expect(readDatabaseLibrarySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        includeAllFolders: false,
        offset: 500,
        recursive: true,
      }),
    );
  });

  it("passes search offset and search limit for search requests", async () => {
    await readLibrarySnapshotRequest({ path: "photos", query: "cover", searchOffset: 200 });

    expect(readDatabaseLibrarySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 200,
        offset: 200,
        query: "cover",
      }),
    );
  });

  it("honors custom media limit for non-search requests", async () => {
    await readLibrarySnapshotRequest({ mediaLimit: 100, path: "photos" });

    expect(readDatabaseLibrarySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 100,
        offset: 0,
        query: undefined,
      }),
    );
  });

  it("honors explicit media limit for search requests", async () => {
    await readLibrarySnapshotRequest({ mediaLimit: 0, path: "photos", query: "cover" });

    expect(readDatabaseLibrarySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 0,
        offset: 0,
        query: "cover",
      }),
    );
  });
});
