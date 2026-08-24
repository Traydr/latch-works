import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseLibrarySnapshot } from "../../server/library/repository";
import {
  DEFAULT_MEDIA_PAGE_LIMIT,
  EXCLUDED_PATHS_LIMIT,
  galleryListingRequestSchema,
  type LibrarySnapshotSource,
  normalizeExcludedPaths,
  readLibrarySnapshotRequest,
} from "./library-service";

const emptyMediaPage = {
  hasMore: false,
  limit: DEFAULT_MEDIA_PAGE_LIMIT,
  nextOffset: null,
  offset: 0,
};

function databaseSnapshot(roots: string[]): DatabaseLibrarySnapshot {
  return {
    allFolders: [],
    folders: [],
    media: [],
    mediaPage: emptyMediaPage,
    roots,
  };
}

/** Records the read the service asks for and answers it from memory. */
function fakeSnapshotSource(roots: string[] = []) {
  return {
    readDatabaseLibrarySnapshot: vi.fn<LibrarySnapshotSource["readDatabaseLibrarySnapshot"]>(
      async () => databaseSnapshot(roots),
    ),
  } satisfies LibrarySnapshotSource;
}

describe("library snapshot reads", () => {
  let source: ReturnType<typeof fakeSnapshotSource>;

  beforeEach(() => {
    source = fakeSnapshotSource(["photos"]);
  });

  it("loads snapshots through the archive reader", async () => {
    const snapshot = await readLibrarySnapshotRequest({ path: "photos" }, source);

    expect(source.readDatabaseLibrarySnapshot).toHaveBeenCalledWith({
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
    await readLibrarySnapshotRequest({ comicMode: true, path: "photos" }, source);

    expect(source.readDatabaseLibrarySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        includeAllFolders: true,
        recursive: true,
      }),
    );
  });
});

describe("recursive folder excludes (Plan 054)", () => {
  it("normalizes excluded paths like the browse path and leaves the rest to the conditions", () => {
    expect(normalizeExcludedPaths(["/photos/kids/", "photos\\teens", "photos/kids"], true)).toEqual(
      ["photos/kids", "photos/teens", "photos/kids"],
    );
  });

  it("normalizes an empty or non-recursive list to an absent field", () => {
    expect(normalizeExcludedPaths([], true)).toBeUndefined();
    expect(normalizeExcludedPaths(undefined, true)).toBeUndefined();
    expect(normalizeExcludedPaths(["photos/kids"], false)).toBeUndefined();
  });

  it("does not carry excludes on the snapshot read", async () => {
    const source = fakeSnapshotSource();
    await readLibrarySnapshotRequest({ path: "photos", recursive: true }, source);
    expect(source.readDatabaseLibrarySnapshot.mock.calls[0]?.[0]).not.toHaveProperty(
      "excludedPaths",
    );
  });

  it("rejects a listing request with more excluded paths than the cap", () => {
    const atCap = Array.from({ length: EXCLUDED_PATHS_LIMIT }, (_, index) => `photos/${index}`);
    const overCap = atCap.concat("photos/one-too-many");
    const listingBase = {
      randomSeed: "0123456789abcdef0123456789abcdef",
      showImages: true,
      showVideos: true,
      sortMode: "name-asc",
    };

    expect(
      galleryListingRequestSchema.safeParse({ ...listingBase, excludedPaths: atCap }).success,
    ).toBe(true);
    expect(
      galleryListingRequestSchema.safeParse({ ...listingBase, excludedPaths: overCap }).success,
    ).toBe(false);
  });
});

describe("library snapshot paging", () => {
  let source: ReturnType<typeof fakeSnapshotSource>;

  beforeEach(() => {
    source = fakeSnapshotSource();
  });

  it("passes media offset and default limit for non-search requests", async () => {
    await readLibrarySnapshotRequest({ mediaOffset: 500, path: "photos" }, source);

    expect(source.readDatabaseLibrarySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: DEFAULT_MEDIA_PAGE_LIMIT,
        offset: 500,
        query: undefined,
      }),
    );
  });

  it("omits all folders for paged comic snapshots when explicitly requested", async () => {
    await readLibrarySnapshotRequest(
      {
        comicMode: true,
        includeAllFolders: false,
        mediaOffset: 500,
        path: "photos",
      },
      source,
    );

    expect(source.readDatabaseLibrarySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        includeAllFolders: false,
        offset: 500,
        recursive: true,
      }),
    );
  });

  it("passes search offset and search limit for search requests", async () => {
    await readLibrarySnapshotRequest({ path: "photos", query: "cover", searchOffset: 200 }, source);

    expect(source.readDatabaseLibrarySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 200,
        offset: 200,
        query: "cover",
      }),
    );
  });

  it("honors custom media limit for non-search requests", async () => {
    await readLibrarySnapshotRequest({ mediaLimit: 100, path: "photos" }, source);

    expect(source.readDatabaseLibrarySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 100,
        offset: 0,
        query: undefined,
      }),
    );
  });

  it("honors explicit media limit for search requests", async () => {
    await readLibrarySnapshotRequest({ mediaLimit: 0, path: "photos", query: "cover" }, source);

    expect(source.readDatabaseLibrarySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 0,
        offset: 0,
        query: "cover",
      }),
    );
  });
});
