import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_GATHER_QUEUE,
  type GatherQueueState,
  GatherQueueStateSchema,
  type OutputGatherQueueJob,
  PROFILE_DELETED_MESSAGE,
} from "../shared/gather-queue";
import { createGatherRunState } from "../shared/gather-run";
import { DEFAULT_PROFILE_ID, DEFAULT_PROFILES, type GatherProfilesState } from "../shared/profiles";
import { DEFAULT_SETTINGS } from "../shared/settings";
import type { DownloadablePayload } from "../shared/types";
import { GatherRunCoordinator } from "./gather-run-coordinator";
import type { GatherRunCoordinatorDependencies } from "./gather-run-coordinator-dependencies";

describe("Gather queue orchestration", () => {
  it("resumes a site-scoped permission job and still queues the confirming tab", async () => {
    const waitingJob = outputJob("waiting", "permission-required");
    waitingJob.run.tabId = 1;

    const harness = createHarness({
      ...EMPTY_GATHER_QUEUE,
      jobs: [waitingJob],
    });

    harness.collect.mockResolvedValue(downloadablePayload());
    harness.getTab.mockResolvedValue(
      tabAt({ id: 99, windowId: 2, url: "https://www.pixiv.net/artworks/2" }),
    );

    const result = await harness.coordinator.startForTab(
      tabAt({ id: 99, windowId: 2, url: "https://www.pixiv.net/artworks/2" }),
    );

    expect(harness.execute).toHaveBeenCalledWith(
      expect.objectContaining({ run: expect.objectContaining({ id: "waiting" }) }),
    );
    expect(harness.collect).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ outcome: "queued", queuedRunId: "new-run" });
    expect(harness.getQueue().jobs).toMatchObject([
      { run: { id: "waiting", phase: "preparing" } },
      {
        run: { id: "new-run", phase: "queued", tabUrl: "https://www.pixiv.net/artworks/2" },
        destinationId: "folder-a",
      },
    ]);
  });

  it("resumes a permission job without re-collecting its own page", async () => {
    const waitingJob = outputJob("waiting", "permission-required");

    const harness = createHarness({
      ...EMPTY_GATHER_QUEUE,
      jobs: [waitingJob],
    });

    const result = await harness.coordinator.startForTab(
      tabAt({ id: 1, windowId: 1, url: "https://www.pixiv.net/artworks/1" }),
    );

    expect(result.outcome).toBe("started");
    expect(harness.collect).not.toHaveBeenCalled();
    expect(harness.execute).toHaveBeenCalledWith(
      expect.objectContaining({ run: expect.objectContaining({ id: "waiting" }) }),
    );
  });

  it("leaves another profile's paused job waiting and queues under the active one", async () => {
    const harness = createHarness({
      ...EMPTY_GATHER_QUEUE,
      jobs: [outputJob("waiting", "permission-required")],
    });

    const tab = tabAt({ id: 99, windowId: 2, url: "https://www.pixiv.net/artworks/2" });
    harness.setProfiles(TWO_PROFILES);
    harness.collect.mockResolvedValue(downloadablePayload());
    harness.getTab.mockResolvedValue(tab);

    await harness.coordinator.startForTab(tab);

    expect(harness.getQueue().jobs).toMatchObject([
      { run: { id: "waiting", phase: "permission-required" }, profileId: DEFAULT_PROFILE_ID },
      { run: { id: "new-run", phase: "queued" }, profileId: "work" },
    ]);
  });

  it("pins the page to the profile the panel confirmed, not one chosen since", async () => {
    const harness = createHarness(EMPTY_GATHER_QUEUE);
    const tab = tabAt({ id: 99, windowId: 2, url: "https://www.pixiv.net/artworks/2" });
    harness.setProfiles(TWO_PROFILES);
    harness.collect.mockResolvedValue(downloadablePayload());
    harness.getTab.mockResolvedValue(tab);

    await harness.coordinator.startForTab(tab, DEFAULT_PROFILE_ID);

    expect(harness.getQueue().jobs).toMatchObject([
      { run: { id: "new-run", phase: "preparing" }, profileId: DEFAULT_PROFILE_ID },
    ]);
  });

  it("ends outputs waiting on a deleted profile so the queue moves on", async () => {
    const harness = createHarness({
      ...EMPTY_GATHER_QUEUE,
      jobs: [
        { ...outputJob("paused", "permission-required"), profileId: "work" },
        { ...outputJob("queued", "queued"), profileId: "work" },
        outputJob("next", "queued"),
      ],
    });

    await harness.coordinator.failDeletedProfileJobs();

    expect(harness.getQueue()).toMatchObject({
      jobs: [{ run: { id: "next", phase: "preparing" } }],
      results: [
        { id: "paused", phase: "failed", error: PROFILE_DELETED_MESSAGE },
        { id: "queued", phase: "failed", error: PROFILE_DELETED_MESSAGE },
      ],
    });
  });

  it("fails rather than pauses a starting output whose profile was deleted", async () => {
    const harness = createHarness({
      ...EMPTY_GATHER_QUEUE,
      jobs: [{ ...outputJob("starting", "preparing"), profileId: "work" }],
    });

    await harness.coordinator.handleEvent({
      type: "GATHER_BOX_RUN_EVENT",
      target: "background",
      runId: "starting",
      event: { kind: "permission-required", scope: "site" },
    });

    expect(harness.getQueue()).toMatchObject({
      jobs: [],
      results: [{ id: "starting", phase: "failed", error: PROFILE_DELETED_MESSAGE }],
    });
  });

  it("names the paused job's profile once there is more than one", async () => {
    const harness = createHarness({
      ...EMPTY_GATHER_QUEUE,
      jobs: [outputJob("waiting", "preparing")],
    });

    harness.setProfiles(TWO_PROFILES);

    await harness.coordinator.handleEvent({
      type: "GATHER_BOX_RUN_EVENT",
      target: "background",
      runId: "waiting",
      event: { kind: "permission-required", scope: "site" },
    });

    expect(harness.getQueue().jobs[0]?.run.progress.message).toBe(
      'Folder access for pixiv needs confirmation from a pixiv page with the "Default" profile.',
    );
  });

  it("persists executor events while another tab is still collecting", async () => {
    let finishCollection!: (value: DownloadablePayload) => void;

    const collection = new Promise<DownloadablePayload>((resolve) => {
      finishCollection = resolve;
    });

    const harness = createHarness({
      ...EMPTY_GATHER_QUEUE,
      jobs: [outputJob("writing", "writing")],
    });

    harness.collect.mockReturnValue(collection);
    harness.getTab.mockResolvedValue(
      tabAt({ id: 2, windowId: 1, url: "https://www.pixiv.net/artworks/2" }),
    );

    const pendingStart = harness.coordinator.startForTab(
      tabAt({ id: 2, windowId: 1, url: "https://www.pixiv.net/artworks/2" }),
    );

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
        failedItems: [{ fileName: "missing.jpg", reason: "network", kind: "error" }],
        retryImages: downloadablePayload().images.slice(0, 1),
      },
    });
    expect(harness.getQueue().results).toMatchObject([
      { id: "writing", phase: "failed", retryImages: [{ fileName: "1.jpg" }] },
    ]);

    finishCollection(downloadablePayload());
    await expect(pendingStart).resolves.toMatchObject({ outcome: "started" });
  });

  it("dispatches exactly one queued output until its terminal event arrives", async () => {
    const harness = createHarness({
      ...EMPTY_GATHER_QUEUE,
      jobs: [outputJob("first", "queued"), outputJob("second", "queued")],
    });

    await harness.coordinator.recover();
    expect(harness.execute).toHaveBeenCalledTimes(1);
    expect(harness.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ run: expect.objectContaining({ id: "first" }) }),
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
        retryImages: [],
      },
    });
    expect(harness.execute).toHaveBeenCalledTimes(2);
    expect(harness.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ run: expect.objectContaining({ id: "second" }) }),
    );
  });

  it("dispatches the next output when a recorded run's terminal report is redelivered", async () => {
    const harness = createHarness({
      ...EMPTY_GATHER_QUEUE,
      jobs: [outputJob("second", "queued")],
    });

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
        retryImages: [],
      },
    });

    expect(harness.execute).toHaveBeenCalledWith(
      expect.objectContaining({ run: expect.objectContaining({ id: "second" }) }),
    );
  });

  it("ignores a redelivered permission pause once the job was resumed", async () => {
    const harness = createHarness({
      ...EMPTY_GATHER_QUEUE,
      jobs: [outputJob("waiting", "writing")],
    });

    await harness.coordinator.handleEvent({
      type: "GATHER_BOX_RUN_EVENT",
      target: "background",
      runId: "waiting",
      event: { kind: "permission-required", scope: "site" },
    });

    expect(harness.getQueue().jobs).toMatchObject([{ run: { id: "waiting", phase: "writing" } }]);
  });

  it("keeps the slot occupied while cancellation settles, then advances", async () => {
    const harness = createHarness({
      ...EMPTY_GATHER_QUEUE,
      jobs: [outputJob("first", "writing"), outputJob("second", "queued")],
    });

    await expect(harness.coordinator.cancel("first")).resolves.toMatchObject({
      outcome: "cancelled",
      run: { phase: "cancelling" },
    });
    expect(harness.abort).toHaveBeenCalledWith("first");
    expect(harness.execute).not.toHaveBeenCalled();

    await harness.coordinator.handleEvent({
      type: "GATHER_BOX_RUN_EVENT",
      target: "background",
      runId: "first",
      event: { kind: "cancelled", message: "Gather Run cancelled." },
    });
    expect(harness.getQueue().results).toMatchObject([{ id: "first", phase: "cancelled" }]);
    expect(harness.execute).toHaveBeenCalledWith(
      expect.objectContaining({ run: expect.objectContaining({ id: "second" }) }),
    );
  });

  it("keeps queued outputs waiting while the executor is busy, and dispatches on its report", async () => {
    const harness = createHarness({
      ...EMPTY_GATHER_QUEUE,
      jobs: [
        outputJob("first", "writing"),
        outputJob("second", "queued"),
        outputJob("third", "queued"),
      ],
    });

    harness.abort.mockResolvedValue(false);
    harness.execute.mockResolvedValueOnce({ outcome: "busy" });

    await harness.coordinator.cancel("first");

    expect(harness.execute).toHaveBeenCalledTimes(1);
    expect(harness.getQueue().results).toMatchObject([{ id: "first", phase: "cancelled" }]);
    expect(harness.getQueue().jobs.map((job) => [job.run.id, job.run.phase])).toEqual([
      ["second", "queued"],
      ["third", "queued"],
    ]);

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
        retryImages: [],
      },
    });

    expect(harness.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ run: expect.objectContaining({ id: "second" }) }),
    );
    expect(harness.getQueue().jobs[0]?.run.phase).toBe("preparing");
  });
});

const TWO_PROFILES: GatherProfilesState = {
  profiles: [...DEFAULT_PROFILES.profiles, { id: "work", name: "Work" }],
  activeProfileId: "work",
};

function outputJob(id: string, phase: OutputGatherQueueJob["run"]["phase"]): OutputGatherQueueJob {
  return {
    kind: "output",
    run: createGatherRunState({
      id,
      tabId: 1,
      windowId: 1,
      tabUrl: "https://www.pixiv.net/artworks/1",
      siteKey: "pixiv",
      phase,
      message: "Preparing Gather Run...",
    }),
    payload: downloadablePayload(),
    settings: DEFAULT_SETTINGS,
    destinationId: null,
    profileId: DEFAULT_PROFILE_ID,
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
    images: [{ originalUrl: "https://example.test/1.jpg", fileName: "1.jpg" }],
  };
}

function createHarness(initial: GatherQueueState) {
  let queue = structuredClone(initial);
  let profiles = DEFAULT_PROFILES;
  const collect = vi.fn<GatherRunCoordinatorDependencies["collect"]>();

  const execute = vi
    .fn<GatherRunCoordinatorDependencies["execute"]>()
    .mockResolvedValue({ outcome: "accepted" });

  const abort = vi.fn<GatherRunCoordinatorDependencies["abort"]>().mockResolvedValue(true);

  const getTab = vi
    .fn<GatherRunCoordinatorDependencies["getTab"]>()
    .mockResolvedValue(tabAt({ id: 1, windowId: 1, url: "https://www.pixiv.net/artworks/1" }));

  const dependencies: GatherRunCoordinatorDependencies = {
    // Read back through the storage schema, as chrome.storage.local does on every load.
    loadQueue: async () => GatherQueueStateSchema.parse(structuredClone(queue)),
    saveQueue: async (next) => {
      queue = structuredClone(next);
    },
    getExecutorStatus: async () => ({ activeRunId: null }),
    getTab,
    collect,
    loadSettings: async () => DEFAULT_SETTINGS,
    loadProfiles: async () => profiles,
    getDestinationId: async () => "folder-a",
    execute,
    abort,
    now: () => 1_000,
    randomUUID: () => "new-run",
  };

  return {
    coordinator: new GatherRunCoordinator(dependencies),
    collect,
    execute,
    abort,
    getTab,
    getQueue: () => queue,
    setProfiles: (next: GatherProfilesState) => {
      profiles = next;
    },
  };
}

/** A Chrome tab with every required field, so tests state only what the assertion depends on. */
function tabAt(fields: Pick<chrome.tabs.Tab, "id" | "url" | "windowId">): chrome.tabs.Tab {
  return {
    active: true,
    autoDiscardable: true,
    discarded: false,
    frozen: false,
    groupId: -1,
    highlighted: false,
    incognito: false,
    index: 0,
    lastAccessed: 0,
    pinned: false,
    selected: true,
    ...fields,
  };
}
