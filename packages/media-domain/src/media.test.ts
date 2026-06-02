import { describe, expect, it } from "vitest";
import { buildComicEntries, detectMediaType, sortMediaItems } from "./index.js";
import type { MediaItem } from "./media.js";

const baseItem = {
  parentPath: "sfw/patreon/sample",
  extension: "jpg",
  mediaType: "image",
  size: 1,
} satisfies Pick<MediaItem, "parentPath" | "extension" | "mediaType" | "size">;

describe("media-domain", () => {
  it("detects archive media types by extension", () => {
    expect(detectMediaType("cover.JPG")).toBe("image");
    expect(detectMediaType("clip.webm")).toBe("video");
    expect(detectMediaType("story.pdf")).toBe("story");
    expect(detectMediaType("notes.txt")).toBeNull();
  });

  it("sorts names with numeric collation", () => {
    const items: MediaItem[] = [
      { ...baseItem, id: "10", name: "10.jpg", path: "comic/10.jpg", mtimeMs: 10 },
      { ...baseItem, id: "2", name: "2.jpg", path: "comic/2.jpg", mtimeMs: 20 },
      { ...baseItem, id: "1", name: "1.jpg", path: "comic/1.jpg", mtimeMs: 30 },
    ];

    expect(sortMediaItems(items, "name-asc", 1).map((item) => item.name)).toEqual([
      "1.jpg",
      "2.jpg",
      "10.jpg",
    ]);
  });

  it("groups image folders as comics while preserving archive paths", () => {
    const items: MediaItem[] = [
      {
        ...baseItem,
        id: "a",
        name: "001.jpg",
        path: "sfw/patreon/post-a/001.jpg",
        parentPath: "sfw/patreon/post-a",
        mtimeMs: 1,
      },
      {
        ...baseItem,
        id: "b",
        name: "002.jpg",
        path: "sfw/patreon/post-a/002.jpg",
        parentPath: "sfw/patreon/post-a",
        mtimeMs: 2,
      },
    ];

    const comics = buildComicEntries(items, "sfw/patreon");
    expect(comics).toHaveLength(1);
    expect(comics[0]?.folderPath).toBe("sfw/patreon/post-a");
    expect(comics[0]?.pages.map((page) => page.name)).toEqual(["001.jpg", "002.jpg"]);
  });
});
