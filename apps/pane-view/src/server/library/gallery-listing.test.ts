import { describe, expect, it } from "vitest";
import {
  decodeGalleryListingCursor,
  encodeGalleryListingCursor,
  type GalleryListingCursorPayload,
} from "./gallery-listing";

const seedA = "0123456789abcdef0123456789abcdef";
const seedB = "fedcba9876543210fedcba9876543210";

const mediaCursor: GalleryListingCursorPayload = {
  filename: "cover.jpg",
  id: "entry-1",
  logicalPath: "photos/2026/cover.jpg",
  mtimeMs: 1_700_000_000_000,
  randomKey: "89abcdef0123456789abcdef01234567",
  randomSeed: seedA,
  sortMode: "random",
  subjectKind: "media",
};

const comicCursor: GalleryListingCursorPayload = {
  folderPath: "photos/2026",
  mtimeMs: 1_700_000_000_000,
  randomSeed: seedA,
  sortMode: "date-newest",
  subjectKind: "comic",
};

describe("gallery listing cursor", () => {
  it("round-trips media and comic payloads for the matching request", () => {
    expect(
      decodeGalleryListingCursor(encodeGalleryListingCursor(mediaCursor), mediaCursor),
    ).toEqual(mediaCursor);
    expect(
      decodeGalleryListingCursor(encodeGalleryListingCursor(comicCursor), comicCursor),
    ).toEqual(comicCursor);
  });

  it("returns null for a missing or malformed cursor", () => {
    expect(decodeGalleryListingCursor(undefined, mediaCursor)).toBeNull();
    expect(decodeGalleryListingCursor("not-base64-json", mediaCursor)).toBeNull();
    expect(
      decodeGalleryListingCursor(Buffer.from("[]").toString("base64url"), mediaCursor),
    ).toBeNull();
  });

  it("rejects a cursor issued under another seed, sort mode, or subject kind", () => {
    const encoded = encodeGalleryListingCursor(mediaCursor);
    expect(decodeGalleryListingCursor(encoded, { ...mediaCursor, randomSeed: seedB })).toBeNull();
    expect(
      decodeGalleryListingCursor(encoded, { ...mediaCursor, sortMode: "name-asc" }),
    ).toBeNull();
    expect(
      decodeGalleryListingCursor(encoded, { ...mediaCursor, subjectKind: "comic" }),
    ).toBeNull();
  });

  it("requires a 32-hex rank in random mode and forbids one elsewhere", () => {
    const withoutKey = Buffer.from(
      JSON.stringify({ ...mediaCursor, randomKey: undefined }),
    ).toString("base64url");
    expect(decodeGalleryListingCursor(withoutKey, mediaCursor)).toBeNull();

    const forgedKey = Buffer.from(JSON.stringify({ ...mediaCursor, randomKey: "zzz" })).toString(
      "base64url",
    );
    expect(decodeGalleryListingCursor(forgedKey, mediaCursor)).toBeNull();

    const strayKey = Buffer.from(
      JSON.stringify({ ...comicCursor, randomKey: mediaCursor.randomKey }),
    ).toString("base64url");
    expect(decodeGalleryListingCursor(strayKey, comicCursor)).toBeNull();
  });

  it("rejects a payload whose fields do not fit its subject kind", () => {
    const missingFilename = Buffer.from(
      JSON.stringify({ ...mediaCursor, filename: undefined }),
    ).toString("base64url");
    expect(decodeGalleryListingCursor(missingFilename, mediaCursor)).toBeNull();

    const missingFolder = Buffer.from(JSON.stringify({ ...comicCursor, folderPath: 7 })).toString(
      "base64url",
    );
    expect(decodeGalleryListingCursor(missingFolder, comicCursor)).toBeNull();
  });
});
