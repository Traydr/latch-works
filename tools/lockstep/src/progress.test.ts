import { describe, expect, it } from "vitest";
import { formatPushStatus, formatScanStatus } from "./progress.js";

describe("formatScanStatus", () => {
  it("formats indexing with current path", () => {
    expect(
      formatScanStatus({
        stage: "scanning",
        filesFound: 120,
        skipped: 3,
        path: "sfw/example.jpg",
      }),
    ).toBe("Indexing sfw/example.jpg · 120 media, 3 skipped");
  });

  it("formats hashing with byte progress", () => {
    expect(
      formatScanStatus({
        stage: "hashing",
        filesFound: 120,
        skipped: 3,
        path: "sfw/example.jpg",
        bytesHashed: 512,
        fileSize: 1024,
      }),
    ).toBe("Hashing sfw/example.jpg (512 B / 1.0 KB, 50%) · 120 media, 3 skipped");
  });
});

describe("formatPushStatus", () => {
  it("formats upload stage with detail", () => {
    expect(
      formatPushStatus({
        current: 2,
        total: 10,
        path: "sfw/a.jpg",
        stage: "uploading",
        detail: "1.2 MB / 4.0 MB",
      }),
    ).toBe("[2/10] Uploading sfw/a.jpg — 1.2 MB / 4.0 MB");
  });
});
