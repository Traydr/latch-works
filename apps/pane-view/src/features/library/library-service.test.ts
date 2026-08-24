import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseLibrarySnapshot } from "../../server/library/repository";
import {
  DEFAULT_MEDIA_PAGE_LIMIT,
  galleryListingRequestSchema,
  type LibrarySnapshotSource,
  libraryRequestSchema,
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
  let source: ReturnType<typeof fakeSnapshotSource>;

  beforeEach(() => {
    source = fakeSnapshotSource();
  });

  it("normalizes excluded paths like the browse path and threads them into the read", async () => {
    await readLibrarySnapshotRequest(
      {
        excludedPaths: ["/photos/kids/", "photos\\teens", "photos/kids"],
        path: "photos",
        recursive: true,
      },
      source,
    );

    expect(source.readDatabaseLibrarySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        excludedPaths: ["photos/kids", "photos/teens"],
        recursive: true,
      }),
    );
  });

  it("keeps the excludes when comic mode alone implies recursive", async () => {
    await readLibrarySnapshotRequest(
      { comicMode: true, excludedPaths: ["photos/kids"], path: "photos" },
      source,
    );

    expect(source.readDatabaseLibrarySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ excludedPaths: ["photos/kids"], recursive: true }),
    );
  });

  it("drops the field before the read when the request is not recursive", async () => {
    await readLibrarySnapshotRequest({ excludedPaths: ["photos/kids"], path: "photos" }, source);

    expect(source.readDatabaseLibrarySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ excludedPaths: undefined, recursive: false }),
    );
  });

  it("normalizes an empty list to an absent field", () => {
    expect(normalizeExcludedPaths([], true)).toBeUndefined();
    expect(normalizeExcludedPaths(undefined, true)).toBeUndefined();
    expect(normalizeExcludedPaths(["photos/kids"], false)).toBeUndefined();
  });

  it("caps excludedPaths at 200 entries in both request schemas", () => {
    const atCap = Array.from({ length: 200 }, (_, index) => `photos/${index}`);
    const overCap = atCap.concat("photos/one-too-many");
    const listingBase = {
      randomSeed: "0123456789abcdef0123456789abcdef",
      showImages: true,
      showVideos: true,
      sortMode: "name-asc",
    };

    expect(libraryRequestSchema.safeParse({ excludedPaths: atCap }).success).toBe(true);
    expect(libraryRequestSchema.safeParse({ excludedPaths: overCap }).success).toBe(false);
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
