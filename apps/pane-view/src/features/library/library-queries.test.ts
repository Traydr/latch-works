import { describe, expect, it } from "vitest";
import { toGalleryRouteLoaderDeps, toLibrarySnapshotRequest } from "./library-queries";

describe("library query request normalization", () => {
  it("ignores recursive and comic modes at archive root", () => {
    expect(toLibrarySnapshotRequest({ recursive: true })).toMatchObject({
      comicMode: false,
      recursive: false,
    });
    expect(toGalleryRouteLoaderDeps({ comic: true, recursive: true })).toMatchObject({
      comicMode: false,
      recursive: false,
    });
  });

  it("keeps recursive folder modes inside archive folders", () => {
    expect(toLibrarySnapshotRequest({ path: "photos", recursive: true })).toMatchObject({
      comicMode: false,
      recursive: true,
    });
    expect(toGalleryRouteLoaderDeps({ comic: true, path: "photos" })).toMatchObject({
      comicMode: true,
      recursive: true,
    });
  });
});
