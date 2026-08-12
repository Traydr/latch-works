import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_GATHER_QUEUE,
  type GatherQueueState,
  type OutputGatherQueueJob
} from "../shared/gather-queue";
import { createGatherRunState } from "../shared/gather-run";
import { DEFAULT_SETTINGS } from "../shared/settings";
import type { DownloadablePayload } from "../shared/types";
import {
  applyGatherRunEvent,
  GatherRunCoordinator,
  type GatherRunCoordinatorDependencies
} from "./gather-run-coordinator";

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

  it("maps cancel events to the cancelled phase", () => {
    const cancelled = applyGatherRunEvent(run, { kind: "cancelled", message: "Stopped." }, 106);
    expect(cancelled).toMatchObject({
      phase: "cancelled",
      error: "Stopped.",
      progress: { message: "Gather Run cancelled." }
    });
  });

  it("rejects unknown event kinds instead of completing", () => {
    expect(() =>
      applyGatherRunEvent(run, { kind: "explode" } as never, 107)
    ).toThrow(/Rejected unknown Gather Run event kind/);
  });
});

describe("Gather queue orchestration", () => {
  it("resumes a site-scoped permission job from a replacement tab", async () => {
    const waitingJob = outputJob("waiting", "permission-required");
    waitingJob.run.tabId = 1;
    const harness = createHarness({
      ...EMPTY_GATHER_QUEUE,
      jobs: [waitingJob]
    });

    const result = await harness.coordinator.startForTab({
      id: 99,
      windowId: 2,
      url: "https://www.pixiv.net/artworks/2"
    } as chrome.tabs.Tab);

    expect(result.outcome).toBe("started");
    expect(harness.collect).not.toHaveBeenCalled();
    expect(harness.execute).toHaveBeenCalledWith(
      expect.objectContaining({ run: expect.objectContaining({ id: "waiting" }) })
    );
  });

  it("persists executor events while another tab is still collecting", async () => {
    let finishCollection!: (value: DownloadablePayload) => void;
    const collection = new Promise<DownloadablePayload>((resolve) => {
      finishCollection = resolve;
    });
    const harness = createHarness({
      ...EMPTY_GATHER_QUEUE,
      jobs: [outputJob("writing", "writing")]
    });
    harness.collect.mockReturnValue(collection);
    harness.getTab.mockResolvedValue({
      id: 2,
      windowId: 1,
      url: "https://www.pixiv.net/artworks/2"
    } as chrome.tabs.Tab);

    const pendingStart = harness.coordinator.startForTab({
      id: 2,
      windowId: 1,
      url: "https://www.pixiv.net/artworks/2"
    } as chrome.tabs.Tab);
    await vi.waitFor(() => expect(harness.collect).toHaveBeenCalledOnce());

    await harness.coordinator.handleEvent({
      type: "GATHER_BOX_RUN_EVENT",
      target: "background",
      runId: "writing",
      event: {
        kind: "complete",
        saved: 0,
        skipped: 0,
        failed: 1,
        failedItems: [{ fileName: "missing.jpg", reason: "network" }],
        retryImages: [downloadablePayload().images[0]]
      }
    });
    expect(harness.getQueue().results).toMatchObject([
      { id: "writing", phase: "failed", retryImages: [{ fileName: "1.jpg" }] }
    ]);

    finishCollection(downloadablePayload());
    await expect(pendingStart).resolves.toMatchObject({ outcome: "started" });
  });

  it("dispatches exactly one queued output until its terminal event arrives", async () => {
    const harness = createHarness({
      ...EMPTY_GATHER_QUEUE,
      jobs: [outputJob("first", "queued"), outputJob("second", "queued")]
    });

    await harness.coordinator.recover();
    expect(harness.execute).toHaveBeenCalledTimes(1);
    expect(harness.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ run: expect.objectContaining({ id: "first" }) })
    );

    await harness.coordinator.handleEvent({
      type: "GATHER_BOX_RUN_EVENT",
      target: "background",
      runId: "first",
      event: {
        kind: "complete",
        saved: 1,
        skipped: 0,
        failed: 0,
        failedItems: [],
        retryImages: []
      }
    });
    expect(harness.execute).toHaveBeenCalledTimes(2);
    expect(harness.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ run: expect.objectContaining({ id: "second" }) })
    );
  });

  it("keeps the slot occupied while cancellation settles, then advances", async () => {
    const harness = createHarness({
      ...EMPTY_GATHER_QUEUE,
      jobs: [outputJob("first", "writing"), outputJob("second", "queued")]
    });

    await expect(harness.coordinator.cancel("first")).resolves.toMatchObject({
      outcome: "cancelled",
      run: { phase: "cancelling" }
    });
    expect(harness.abort).toHaveBeenCalledWith("first");
    expect(harness.execute).not.toHaveBeenCalled();

    await harness.coordinator.handleEvent({
      type: "GATHER_BOX_RUN_EVENT",
      target: "background",
      runId: "first",
      event: { kind: "cancelled", message: "Gather Run cancelled." }
    });
    expect(harness.getQueue().results).toMatchObject([{ id: "first", phase: "cancelled" }]);
    expect(harness.execute).toHaveBeenCalledWith(
      expect.objectContaining({ run: expect.objectContaining({ id: "second" }) })
    );
  });
});

function outputJob(
  id: string,
  phase: OutputGatherQueueJob["run"]["phase"]
): OutputGatherQueueJob {
  return {
    kind: "output",
    run: {
      ...createGatherRunState({
        id,
        tabId: 1,
        windowId: 1,
        tabUrl: "https://www.pixiv.net/artworks/1",
        siteKey: "pixiv"
      }),
      phase
    },
    payload: downloadablePayload(),
    settings: DEFAULT_SETTINGS
  };
}

function downloadablePayload(): DownloadablePayload {
  return {
    ok: true,
    outputKind: "downloadable-files",
    site: "pixiv",
    title: "One",
    pageUrl: "https://www.pixiv.net/artworks/1",
    galleryId: "1",
    folderSegments: ["artist"],
    skippedCount: 0,
    images: [
      {
        pageNumber: 1,
        thumbnailUrl: null,
        originalUrl: "https://example.test/1.jpg",
        fileName: "1.jpg"
      }
    ]
  };
}

function createHarness(initial: GatherQueueState) {
  let queue = structuredClone(initial);
  const collect = vi.fn<GatherRunCoordinatorDependencies["collect"]>();
  const execute = vi.fn<GatherRunCoordinatorDependencies["execute"]>().mockResolvedValue(true);
  const abort = vi.fn<GatherRunCoordinatorDependencies["abort"]>().mockResolvedValue(true);
  const getTab = vi.fn<GatherRunCoordinatorDependencies["getTab"]>().mockResolvedValue(
    { id: 1, windowId: 1, url: "https://www.pixiv.net/artworks/1" } as chrome.tabs.Tab
  );
  const dependencies: GatherRunCoordinatorDependencies = {
    loadQueue: async () => structuredClone(queue),
    saveQueue: async (next) => {
      queue = structuredClone(next);
    },
    getActiveRunId: async () => null,
    getTab,
    collect,
    loadSettings: async () => DEFAULT_SETTINGS,
    execute,
    abort,
    now: () => 1_000,
    randomUUID: () => "new-run"
  };
  return {
    coordinator: new GatherRunCoordinator(dependencies),
    collect,
    execute,
    abort,
    getTab,
    getQueue: () => queue
  };
}
