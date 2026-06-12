import type { ScanArchiveProgress } from "@latch-works/media-index";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScanProgressCoalescer } from "./scan-progress-coalescer.js";

const hashingProgress = (
  path: string,
  bytesHashed: number,
  overrides: Partial<Extract<ScanArchiveProgress, { stage: "hashing" }>> = {},
): Extract<ScanArchiveProgress, { stage: "hashing" }> => ({
  bytesHashed,
  fileSize: 10_000,
  filesFound: 1,
  path,
  skipped: 0,
  stage: "hashing",
  ...overrides,
});

describe("createScanProgressCoalescer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces many hashing updates within the throttle window", () => {
    const emitted: ScanArchiveProgress[] = [];
    const coalescer = createScanProgressCoalescer({
      emit: (progress) => emitted.push(progress),
      now: () => 0,
      throttleMs: 200,
    });

    coalescer.onProgress(hashingProgress("photos/a.jpg", 100));
    coalescer.onProgress(hashingProgress("photos/a.jpg", 200));
    coalescer.onProgress(hashingProgress("photos/a.jpg", 300));

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ bytesHashed: 100, path: "photos/a.jpg" });
  });

  it("emits another event after the throttle window", () => {
    let currentTime = 0;
    const emitted: ScanArchiveProgress[] = [];
    const coalescer = createScanProgressCoalescer({
      emit: (progress) => emitted.push(progress),
      now: () => currentTime,
      throttleMs: 200,
    });

    coalescer.onProgress(hashingProgress("photos/a.jpg", 100));
    expect(emitted).toHaveLength(1);

    currentTime = 50;
    coalescer.onProgress(hashingProgress("photos/a.jpg", 200));
    vi.advanceTimersByTime(150);

    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toMatchObject({ bytesHashed: 200 });

    currentTime = 250;
    coalescer.onProgress(hashingProgress("photos/a.jpg", 300));
    expect(emitted).toHaveLength(3);
    expect(emitted[2]).toMatchObject({ bytesHashed: 300 });
  });

  it("emits promptly when the path changes", () => {
    const emitted: ScanArchiveProgress[] = [];
    const coalescer = createScanProgressCoalescer({
      emit: (progress) => emitted.push(progress),
      now: () => 0,
      throttleMs: 200,
    });

    coalescer.onProgress(hashingProgress("photos/a.jpg", 100));
    coalescer.onProgress(hashingProgress("photos/b.jpg", 50));

    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toMatchObject({ bytesHashed: 50, path: "photos/b.jpg" });
  });

  it("flushes the latest pending progress on completion", () => {
    let currentTime = 0;
    const emitted: ScanArchiveProgress[] = [];
    const coalescer = createScanProgressCoalescer({
      emit: (progress) => emitted.push(progress),
      now: () => currentTime,
      throttleMs: 200,
    });

    coalescer.onProgress(hashingProgress("photos/a.jpg", 100));
    currentTime = 10;
    coalescer.onProgress(hashingProgress("photos/a.jpg", 900));

    expect(emitted).toHaveLength(1);

    coalescer.flush();

    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toMatchObject({ bytesHashed: 900 });
  });

  it("clears scheduled timers on dispose", () => {
    let currentTime = 0;
    const emitted: ScanArchiveProgress[] = [];
    const coalescer = createScanProgressCoalescer({
      emit: (progress) => emitted.push(progress),
      now: () => currentTime,
      throttleMs: 200,
    });

    coalescer.onProgress(hashingProgress("photos/a.jpg", 100));
    currentTime = 10;
    coalescer.onProgress(hashingProgress("photos/a.jpg", 500));
    coalescer.dispose();

    vi.advanceTimersByTime(500);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ bytesHashed: 100 });
  });
});
