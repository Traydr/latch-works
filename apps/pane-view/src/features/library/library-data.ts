import type { FolderNode, MediaItem } from "@latch-works/media-domain";

export const libraryStats = {
  archiveSize: "35.9 GB archive",
  monthlyGrowth: "~1 GB / month",
};

export const fixtureFolders: FolderNode[] = [
  {
    path: "nsfw",
    parentPath: "",
    name: "nsfw",
    hasChildren: true,
    mediaCount: 0,
    folderCount: 0,
  },
  {
    path: "nsfw-stories",
    parentPath: "",
    name: "nsfw-stories",
    hasChildren: true,
    mediaCount: 1,
    folderCount: 0,
  },
  {
    path: "sfw",
    parentPath: "",
    name: "sfw",
    hasChildren: true,
    mediaCount: 4,
    folderCount: 0,
  },
  {
    path: "sfw/patreon/example-creator",
    parentPath: "sfw/patreon",
    name: "example-creator",
    hasChildren: true,
    mediaCount: 3,
    folderCount: 1,
  },
  {
    path: "sfw/patreon/reference-pack",
    parentPath: "sfw/patreon",
    name: "reference-pack",
    hasChildren: true,
    mediaCount: 2,
    folderCount: 0,
  },
];

export const fixtureMedia: MediaItem[] = [
  {
    id: "fixture-001",
    path: "sfw/patreon/example-creator/post-001/001.jpg",
    parentPath: "sfw/patreon/example-creator/post-001",
    name: "001.jpg",
    extension: "jpg",
    mediaType: "image",
    size: 842_441,
    mtimeMs: Date.parse("2026-05-31T19:20:00.000Z"),
  },
  {
    id: "fixture-002",
    path: "sfw/patreon/example-creator/post-001/002.jpg",
    parentPath: "sfw/patreon/example-creator/post-001",
    name: "002.jpg",
    extension: "jpg",
    mediaType: "image",
    size: 901_114,
    mtimeMs: Date.parse("2026-05-31T19:21:00.000Z"),
  },
  {
    id: "fixture-003",
    path: "sfw/patreon/example-creator/clip-preview.mp4",
    parentPath: "sfw/patreon/example-creator",
    name: "clip-preview.mp4",
    extension: "mp4",
    mediaType: "video",
    size: 7_411_932,
    mtimeMs: Date.parse("2026-05-26T12:00:00.000Z"),
    durationMs: 36_000,
  },
  {
    id: "fixture-004",
    path: "nsfw-stories/archiveofourown/example-story.pdf",
    parentPath: "nsfw-stories/archiveofourown",
    name: "example-story.pdf",
    extension: "pdf",
    mediaType: "story",
    size: 491_120,
    mtimeMs: Date.parse("2026-05-24T10:30:00.000Z"),
    pageCount: 18,
  },
  {
    id: "fixture-005",
    path: "sfw/patreon/reference-pack/animated-sample.gif",
    parentPath: "sfw/patreon/reference-pack",
    name: "animated-sample.gif",
    extension: "gif",
    mediaType: "image",
    size: 2_144_900,
    mtimeMs: Date.parse("2026-05-20T08:10:00.000Z"),
  },
];
