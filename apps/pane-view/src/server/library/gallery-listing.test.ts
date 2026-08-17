import { describe, expect, it } from "vitest";
import {
  decodeGalleryListingCursor,
  encodeGalleryListingCursor,
  galleryListingRandomHash,
} from "./gallery-listing";

describe("gallery listing cursor", () => {
  it("round-trips cursor payloads", () => {
    const encoded = encodeGalleryListingCursor({
      filename: "cover.jpg",
      id: "entry-1",
      logicalPath: "photos/2026/cover.jpg",
      mtimeMs: 1_700_000_000_000,
      randomHash: galleryListingRandomHash("2a", "entry-1"),
      randomSeed: "2a",
      sortMode: "random",
    });

    expect(decodeGalleryListingCursor(encoded)).toEqual({
      filename: "cover.jpg",
      id: "entry-1",
      logicalPath: "photos/2026/cover.jpg",
      mtimeMs: 1_700_000_000_000,
      randomHash: galleryListingRandomHash("2a", "entry-1"),
      randomSeed: "2a",
      sortMode: "random",
    });
  });
});
