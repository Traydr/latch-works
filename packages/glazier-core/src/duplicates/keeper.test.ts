import { describe, expect, it } from "vitest";

import { FileIdSchema } from "../contract.js";
import { type KeeperCandidate, rankKeepers } from "./keeper.js";

function candidate(id: number, overrides: Partial<KeeperCandidate>): KeeperCandidate {
  return {
    id: FileIdSchema.parse(id),
    relPath: `copies/${id}.png`,
    kind: "image",
    format: "png",
    ext: "png",
    extensionMismatch: false,
    videoCodec: null,
    width: 1000,
    height: 1000,
    durationMs: null,
    audioState: null,
    size: 1_000_000,
    mtimeMs: 1_700_000_000_000,
    isPreferred: false,
    ...overrides,
  };
}

/** The ranked ids and the rule that put the first ahead of the second. */
function rank(candidates: KeeperCandidate[]) {
  const { ranked, reason } = rankKeepers(candidates);

  return { order: ranked.map((entry) => entry.id), reason };
}

const mp4 = { kind: "video", format: "mp4", videoCodec: "h264" } as const;

describe("keeper rules", () => {
  it("keeps a copy in a preferred folder over a better one elsewhere", () => {
    expect(
      rank([candidate(1, { width: 4000, height: 3000 }), candidate(2, { isPreferred: true })]),
    ).toEqual({ order: [2, 1], reason: "preferred-folder" });
  });

  it("keeps the video you can hear over a sharper silent one", () => {
    expect(
      rank([
        candidate(1, { ...mp4, audioState: "none", width: 1920, height: 1080 }),
        candidate(2, { ...mp4, audioState: "silent", width: 1920, height: 1080 }),
        candidate(3, { ...mp4, audioState: "sound", width: 1280, height: 720 }),
      ]),
    ).toEqual({ order: [3, 2, 1], reason: "has-sound" });
  });

  it("keeps more pixels, then the longer video, then the archive format", () => {
    expect(rank([candidate(1, { width: 800, height: 600 }), candidate(2, {})])).toEqual({
      order: [2, 1],
      reason: "more-pixels",
    });
    expect(
      rank([
        candidate(1, { ...mp4, durationMs: 30_000 }),
        candidate(2, { kind: "video", format: "webm", videoCodec: "vp9", durationMs: 31_000 }),
      ]),
    ).toEqual({ order: [2, 1], reason: "longer" });
    expect(
      rank([candidate(1, { size: 2_000_000 }), candidate(2, { format: "avif", size: 300_000 })]),
    ).toEqual({ order: [2, 1], reason: "archive-format" });
  });

  it("keeps the format's own extension over an accepted one, and that over a wrong one", () => {
    // The same MP4 bytes as `.m4v` once beat `.mp4` on a one-character-shorter path.
    expect(
      rank([
        candidate(1, { ...mp4, relPath: "misc/loop-0.m4v", ext: "m4v" }),
        candidate(2, { ...mp4, relPath: "clips/loop-0.mp4", ext: "mp4" }),
      ]),
    ).toEqual({ order: [2, 1], reason: "right-extension" });
    expect(
      rank([
        candidate(1, { relPath: "a.jpg", ext: "jpg", extensionMismatch: true }),
        candidate(2, { relPath: "a/b/c.apng", ext: "apng" }),
      ]),
    ).toEqual({ order: [2, 1], reason: "right-extension" });
  });

  it("keeps more bytes before looking at names", () => {
    expect(
      rank([
        candidate(1, { relPath: "photo.png" }),
        candidate(2, { relPath: "photo (1).png", size: 1_000_001 }),
      ]),
    ).toEqual({ order: [2, 1], reason: "larger-file" });
  });

  it("keeps the original name over one with a copy suffix, before age and path length", () => {
    // `misc/sunset-060 (1).png` once won over `photos/2021/sunset-060.png` on path length.
    expect(
      rank([
        candidate(1, { relPath: "misc/sunset-060 (1).png" }),
        candidate(2, { relPath: "photos/2021/sunset-060.png" }),
      ]),
    ).toEqual({ order: [2, 1], reason: "original-name" });

    for (const copy of ["photo copy", "photo copy 2", "photo-copy", "photo_copy", "photo 2"]) {
      expect(
        rank([
          candidate(1, { relPath: `${copy}.png`, mtimeMs: 1 }),
          candidate(2, { relPath: "deeper/folder/photo.png" }),
        ]).order,
      ).toEqual([2, 1]);
    }
  });

  it("only counts a copy suffix against the name it copies", () => {
    expect(
      rank([
        candidate(1, { relPath: "photo 2.png", mtimeMs: 1_600_000_000_000 }),
        candidate(2, { relPath: "sunset.png" }),
      ]),
    ).toEqual({ order: [1, 2], reason: "oldest" });
  });

  it("breaks the remaining ties by age, path length and natural name order", () => {
    expect(rank([candidate(1, {}), candidate(2, { mtimeMs: 1_600_000_000_000 })])).toEqual({
      order: [2, 1],
      reason: "oldest",
    });
    expect(
      rank([candidate(1, { relPath: "a/b/c/photo.png" }), candidate(2, { relPath: "photo.png" })]),
    ).toEqual({ order: [2, 1], reason: "shorter-path" });
    expect(
      rank([candidate(1, { relPath: "photo 10.png" }), candidate(2, { relPath: "photo 09.png" })]),
    ).toEqual({ order: [2, 1], reason: "name-order" });
  });
});
