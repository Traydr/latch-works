import { describe, expect, it } from "vitest";
import {
  groupXPostInFolder,
  lowercaseFirstAscii,
  sanitizeFileName,
  sanitizePathSegment
} from "./path";
import type { DownloadablePayload } from "./types";

describe("ASCII name normalization", () => {
  it("lowercases only an initial ASCII capital", () => {
    expect(lowercaseFirstAscii("Artist_Name")).toBe("artist_Name");
    expect(lowercaseFirstAscii("_Artist")).toBe("_Artist");
    expect(lowercaseFirstAscii("éArtist")).toBe("éArtist");
  });
});

describe("path sanitization", () => {
  it("rejects dot and parent directory segments", () => {
    expect(sanitizePathSegment(".")).toBe("");
    expect(sanitizePathSegment("..")).toBe("");
    expect(sanitizePathSegment(" . ")).toBe("");
    expect(sanitizePathSegment(" .. ")).toBe("");
  });

  it("still sanitizes ordinary titles", () => {
    expect(sanitizePathSegment("My Comic!")).toBe("My_Comic!");
    expect(sanitizeFileName("../../evil name?.jpg")).toBe("evil_name_.jpg");
  });

  it("preserves trailing underscores used by X usernames", () => {
    expect(sanitizePathSegment(lowercaseFirstAscii("ILIE_ILIE_"))).toBe("iLIE_ILIE_");
    expect(sanitizePathSegment("ILIE_ILIE_.")).toBe("ILIE_ILIE_");
  });
});

describe("X post folders", () => {
  const xPost = (fileNames: string[]): DownloadablePayload => ({
    ok: true,
    outputKind: "downloadable-files",
    site: "x",
    title: "post",
    pageUrl: "https://x.com/Artist/status/123",
    galleryId: "123",
    folderSegments: ["artist"],
    skippedCount: 0,
    images: fileNames.map((fileName, index) => ({
      pageNumber: index + 1,
      thumbnailUrl: null,
      originalUrl: `https://pbs.twimg.com/media/${fileName}`,
      fileName
    }))
  });

  it("files a multi-image post under its ID with the post order as a prefix", () => {
    const grouped = groupXPostInFolder(xPost(["GxB.jpg", "GxA.png", "GxC.jpg"]));

    expect(grouped.folderSegments).toEqual(["artist", "123"]);
    expect(grouped.images.map((image) => image.fileName)).toEqual([
      "01_GxB.jpg",
      "02_GxA.png",
      "03_GxC.jpg"
    ]);
  });

  it("leaves single-image posts in the user folder", () => {
    const post = xPost(["GxA.jpg"]);

    expect(groupXPostInFolder(post)).toBe(post);
  });
});
