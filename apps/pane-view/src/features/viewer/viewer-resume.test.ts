import { describe, expect, it } from "vitest";
import { resolveVideoResumeSeconds, videoSecondsToPositionMs } from "./viewer-resume";

describe("resolveVideoResumeSeconds", () => {
  it("returns null when position is missing", () => {
    expect(resolveVideoResumeSeconds(undefined, 120)).toBeNull();
  });

  it("clamps restored position to one second before duration", () => {
    expect(resolveVideoResumeSeconds(125_000, 120)).toBe(119);
  });

  it("converts milliseconds to seconds within duration", () => {
    expect(resolveVideoResumeSeconds(45_500, 120)).toBe(45.5);
  });
});

describe("videoSecondsToPositionMs", () => {
  it("rounds seconds to integer milliseconds", () => {
    expect(videoSecondsToPositionMs(12.345)).toBe(12_345);
  });
});
