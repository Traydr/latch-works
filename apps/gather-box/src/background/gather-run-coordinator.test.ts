import { describe, expect, it } from "vitest";
import { createGatherRunState } from "../shared/gather-run";
import { applyGatherRunEvent } from "./gather-run-coordinator";

const run = createGatherRunState({
  id: "run-1",
  tabId: 7,
  windowId: 2,
  tabUrl: "https://www.pixiv.net/artworks/1",
  siteKey: "pixiv",
  now: 100
});

describe("Gather Run transitions", () => {
  it("moves through permission, writing, progress, and completion", () => {
    const permission = applyGatherRunEvent(run, { kind: "permission-required" }, 101);
    expect(permission.phase).toBe("permission-required");

    const writing = applyGatherRunEvent(
      permission,
      {
        kind: "writing",
        destinationPreview: "Archive/pixiv/1",
        folderSegments: ["pixiv", "1"],
        total: 2
      },
      102
    );
    expect(writing).toMatchObject({ phase: "writing", destinationPreview: "Archive/pixiv/1" });

    const progress = applyGatherRunEvent(
      writing,
      { kind: "progress", completed: 1, total: 2, message: "Processed 1 of 2." },
      103
    );
    const complete = applyGatherRunEvent(
      progress,
      {
        kind: "complete",
        saved: 2,
        skipped: 0,
        failed: 0,
        failedItems: [],
        retryImages: []
      },
      104
    );
    expect(complete).toMatchObject({
      phase: "complete",
      updatedAt: 104,
      progress: { saved: 2, skipped: 0, failed: 0 }
    });
  });

  it("preserves retry input when an output finishes with failures", () => {
    const image = {
      pageNumber: 1,
      thumbnailUrl: null,
      originalUrl: "https://example.test/1.jpg",
      fileName: "1.jpg"
    };
    const failed = applyGatherRunEvent(
      run,
      {
        kind: "complete",
        saved: 0,
        skipped: 0,
        failed: 1,
        failedItems: [{ fileName: "1.jpg", reason: "network" }],
        retryImages: [image]
      },
      105
    );
    expect(failed.phase).toBe("failed");
    expect(failed.retryImages).toEqual([image]);
  });
});
