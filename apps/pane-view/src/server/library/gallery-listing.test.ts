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
      logicalPath: "sfw/patreon/cover.jpg",
      mtimeMs: 1_700_000_000_000,
      randomHash: galleryListingRandomHash(42, "entry-1"),
      randomSeed: 42,
      sortMode: "random",
    });

    expect(decodeGalleryListingCursor(encoded)).toEqual({
      filename: "cover.jpg",
      id: "entry-1",
      logicalPath: "sfw/patreon/cover.jpg",
      mtimeMs: 1_700_000_000_000,
      randomHash: galleryListingRandomHash(42, "entry-1"),
      randomSeed: 42,
      sortMode: "random",
    });
  });
});
