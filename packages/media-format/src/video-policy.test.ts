import { describe, expect, it } from "vitest";
import { planArchiveVideo, planStripAudio, planVideoReencode } from "./video-policy";

describe("archive video policy", () => {
  it("leaves an MP4 with archive codecs alone", () => {
    expect(
      planArchiveVideo({
        fileName: "clip.mp4",
        container: "mp4",
        videoCodec: "avc",
        audioCodec: "aac",
      }),
    ).toBeNull();
    expect(
      planArchiveVideo({
        fileName: "clip.mp4",
        container: "mp4",
        videoCodec: "av1",
        audioCodec: null,
      }),
    ).toBeNull();
  });

  it("renames MP4 bytes with another extension instead of rewriting them", () => {
    expect(
      planArchiveVideo({
        fileName: "clip.m4v",
        container: "mp4",
        videoCodec: "hevc",
        audioCodec: "mp3",
      }),
    ).toEqual({ action: "rename-mp4", fileName: "clip.mp4" });
  });

  it("copies archive-codec tracks when moving another container into MP4", () => {
    expect(
      planArchiveVideo({
        fileName: "talk.mov",
        container: "mov",
        videoCodec: "avc",
        audioCodec: "aac",
      }),
    ).toEqual({
      action: "convert-mp4",
      fileName: "talk.mp4",
      video: { action: "copy" },
      audio: { action: "copy" },
    });
  });

  it("re-encodes non-archive tracks to H.264 and AAC", () => {
    expect(
      planArchiveVideo({
        fileName: "scene.webm",
        container: "webm",
        videoCodec: "vp9",
        audioCodec: "opus",
      }),
    ).toEqual({
      action: "convert-mp4",
      fileName: "scene.mp4",
      video: { action: "encode", codec: "avc" },
      audio: { action: "encode-aac" },
    });
  });

  it("reports containers it cannot read and files without video", () => {
    expect(
      planArchiveVideo({
        fileName: "old.avi",
        container: "avi",
        videoCodec: "other",
        audioCodec: "mp3",
      }),
    ).toEqual({
      action: "unsupported",
      reason: "The AVI container cannot be read for conversion.",
    });
    expect(
      planArchiveVideo({
        fileName: "song.mp4",
        container: "mp4",
        videoCodec: null,
        audioCodec: "aac",
      }),
    ).toEqual({ action: "unsupported", reason: "The file has no video track." });
  });

  it("re-encodes on request and strips audio on request", () => {
    const source = {
      fileName: "clip.mkv",
      container: "matroska",
      videoCodec: "avc",
      audioCodec: "opus",
    } as const;

    expect(planVideoReencode(source, "av1")).toEqual({
      action: "convert-mp4",
      fileName: "clip.mp4",
      video: { action: "encode", codec: "av1" },
      audio: { action: "encode-aac" },
    });
    expect(planStripAudio(source)).toEqual({
      action: "convert-mp4",
      fileName: "clip.mp4",
      video: { action: "copy" },
      audio: { action: "drop" },
    });
  });
});
