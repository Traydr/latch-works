import { describe, expect, it } from "vitest";
import { buildComicEntries, detectMediaType, sortComicEntries, sortMediaItems } from "./index.js";
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
    expect(detectMediaType("story.pdf")).toBe("pdf");
    expect(detectMediaType("notes.txt")).toBe("unknown");
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

  it("uses a stable path-derived order for random sorting", () => {
    const items: MediaItem[] = [
      { ...baseItem, id: "a", name: "a.jpg", path: "comic/a.jpg", mtimeMs: 1 },
      { ...baseItem, id: "b", name: "b.jpg", path: "comic/b.jpg", mtimeMs: 2 },
      { ...baseItem, id: "c", name: "c.jpg", path: "comic/c.jpg", mtimeMs: 3 },
    ];

    expect(sortMediaItems(items, "random", 42).map((item) => item.id)).toEqual(
      sortMediaItems([...items].reverse(), "random", 42).map((item) => item.id),
    );
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

  it("treats images and GIFs as comic pages while excluding root files", () => {
    const items: MediaItem[] = [
      { ...baseItem, id: "root", name: "root.jpg", path: "comics/root.jpg", mtimeMs: 1 },
      {
        ...baseItem,
        id: "gif",
        name: "002.gif",
        path: "comics/my_comic-title/002.gif",
        mediaType: "gif",
        extension: "gif",
        mtimeMs: 2,
      },
      {
        ...baseItem,
        id: "cover",
        name: "001.jpg",
        path: "comics/my_comic-title/001.jpg",
        mtimeMs: 3,
      },
      {
        ...baseItem,
        id: "video",
        name: "clip.mp4",
        path: "comics/my_comic-title/clip.mp4",
        mediaType: "video",
        extension: "mp4",
        mtimeMs: 4,
      },
    ];

    const comics = buildComicEntries(items, "comics");
    expect(comics).toHaveLength(1);
    expect(comics[0]?.name).toBe("my comic title");
    expect(comics[0]?.cover.id).toBe("cover");
    expect(comics[0]?.pages.map((page) => page.id)).toEqual(["cover", "gif"]);
    expect(sortComicEntries(comics, "name-asc", 1).map((comic) => comic.id)).toEqual([
      "comics/my_comic-title",
    ]);
  });

  it("skips non-leaf folders when leafFoldersOnly is enabled", () => {
    const items: MediaItem[] = [
      {
        ...baseItem,
        id: "parent-cover",
        name: "cover.jpg",
        path: "comics/series/cover.jpg",
        parentPath: "comics/series",
        mtimeMs: 1,
      },
      {
        ...baseItem,
        id: "page-1",
        name: "001.jpg",
        path: "comics/series/chapter-1/001.jpg",
        parentPath: "comics/series/chapter-1",
        mtimeMs: 2,
      },
    ];

    const comics = buildComicEntries(items, "comics", {
      leafFoldersOnly: true,
      folders: [{ parentPath: "comics" }, { parentPath: "comics/series" }],
    });

    expect(comics.map((comic) => comic.folderPath)).toEqual(["comics/series/chapter-1"]);
    expect(comics[0]?.cover.name).toBe("001.jpg");
  });
});
