import { describe, expect, it } from "vitest";

import { FileIdSchema } from "../contract.js";
import { type KeeperCandidate, rankKeepers } from "./keeper.js";

function candidate(id: number, overrides: Partial<KeeperCandidate>): KeeperCandidate {
  return {
    id: FileIdSchema.parse(id),
    relPath: `copies/${id}.png`,
    kind: "image",
    format: "png",
    videoCodec: null,
    width: 1000,
    height: 1000,
    durationMs: null,
    audioState: null,
    size: 1_000_000,
    mtimeMs: 1_700_000_000_000,
    isProtected: false,
    ...overrides,
  };
}

const order = (candidates: KeeperCandidate[]) => rankKeepers(candidates).map((entry) => entry.id);

describe("keeper rules", () => {
  it("keeps a protected copy over a better one elsewhere", () => {
    expect(
      order([candidate(1, { width: 4000, height: 3000 }), candidate(2, { isProtected: true })]),
    ).toEqual([2, 1]);
  });

  it("keeps the video you can hear over a sharper silent one", () => {
    const video = { kind: "video" as const, format: "mp4" as const, videoCodec: "h264" };

    expect(
      order([
        candidate(1, { ...video, audioState: "none", width: 1920, height: 1080 }),
        candidate(2, { ...video, audioState: "silent", width: 1920, height: 1080 }),
        candidate(3, { ...video, audioState: "sound", width: 1280, height: 720 }),
      ]),
    ).toEqual([3, 2, 1]);
  });

  it("keeps more pixels, then the longer video, then the archive format", () => {
    expect(order([candidate(1, { width: 800, height: 600 }), candidate(2, {})])).toEqual([2, 1]);
    expect(
      order([
        candidate(1, { kind: "video", format: "mp4", videoCodec: "h264", durationMs: 30_000 }),
        candidate(2, { kind: "video", format: "webm", videoCodec: "vp9", durationMs: 31_000 }),
      ]),
    ).toEqual([2, 1]);
    expect(
      order([candidate(1, { size: 2_000_000 }), candidate(2, { format: "avif", size: 300_000 })]),
    ).toEqual([2, 1]);
  });

  it("breaks the remaining ties by size, age, path length and natural name order", () => {
    expect(order([candidate(1, { size: 900_000 }), candidate(2, {})])).toEqual([2, 1]);
    expect(order([candidate(1, {}), candidate(2, { mtimeMs: 1_600_000_000_000 })])).toEqual([2, 1]);
    expect(
      order([candidate(1, { relPath: "a/b/c/photo.png" }), candidate(2, { relPath: "photo.png" })]),
    ).toEqual([2, 1]);
    expect(
      order([candidate(1, { relPath: "photo 10.png" }), candidate(2, { relPath: "photo 9.png" })]),
    ).toEqual([2, 1]);
  });
});
