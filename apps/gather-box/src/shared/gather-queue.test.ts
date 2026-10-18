import { describe, expect, it } from "vitest";
import { createGatherRunState, type GatherRunState } from "./gather-run";
import {
  EMPTY_GATHER_QUEUE,
  GATHER_QUEUE_SCHEMA_VERSION,
  getGatherQueueBatch,
  getGatherQueueDisplayRun,
  getLatestGatherQueueResult,
  getRetryableGatherQueueResult,
  getNextQueuedGatherJob,
  getPermissionRequiredGatherJob,
  GatherQueueStateSchema,
  recordGatherQueueResult,
  recoverStoppedGatherQueue,
  withdrawGatherQueueResult,
  type GatherQueueJob,
  type GatherQueueState
} from "./gather-queue";
import { DEFAULT_PROFILE_ID } from "./profiles";
import { DEFAULT_SETTINGS } from "./settings";
import type { DownloadablePayload } from "./types";

function payload(title: string): DownloadablePayload {
  return {
    ok: true,
    outputKind: "downloadable-files",
    site: "pixiv",
    title,
    pageUrl: "https://www.pixiv.net/artworks/1",
    galleryId: "1",
    folderSegments: ["artist-1"],
    skippedCount: 0,
    images: [
      {
        pageNumber: 1,
        thumbnailUrl: null,
        originalUrl: "https://i.pximg.net/img-original/1.jpg",
        fileName: "1.jpg"
      }
    ]
  };
}

function run<
  TPhase extends "collecting" | "queued" | "writing" | "cancelling" | "permission-required"
>(
  id: string,
  phase: TPhase
): ReturnType<typeof createGatherRunState> & { phase: TPhase } {
  return {
    ...createGatherRunState({
      id,
      tabId: Number(id.at(-1)) || 1,
      windowId: 1,
      tabUrl: `https://www.pixiv.net/artworks/${id}`,
      siteKey: "pixiv"
    }),
    phase,
    progress: {
      completed: 0,
      total: 1,
      saved: 0,
      skipped: 0,
      failed: 0,
      message: phase === "writing" ? "Writing Gather Output..." : "Queued."
    }
  };
}

function finished(id: string, createdAt: number, updatedAt: number, saved: number, failed = 0) {
  return {
    ...run(id, "writing"),
    phase: "complete" as const,
    createdAt,
    updatedAt,
    progress: { completed: saved, total: saved, saved, skipped: 1, failed, message: "" },
    retryImages: failed > 0 ? payload(id).images : []
  };
}

function waiting(id: string, createdAt: number): GatherQueueJob {
  return {
    kind: "output",
    run: { ...run(id, "queued"), createdAt },
    payload: payload(id),
    settings: DEFAULT_SETTINGS,
    destinationId: null,
    profileId: DEFAULT_PROFILE_ID
  };
}

function finish(queue: GatherQueueState, result: GatherRunState): GatherQueueState {
  return recordGatherQueueResult(
    { ...queue, jobs: queue.jobs.filter((job) => job.run.id !== result.id) },
    result
  );
}

describe("Gather queue state", () => {
  it("keeps the executing job visible and reports pending jobs", () => {
    const queue: GatherQueueState = {
      schemaVersion: GATHER_QUEUE_SCHEMA_VERSION,
      batch: null,
      results: [],
      jobs: [
        {
          kind: "output",
          run: run("run-1", "writing"),
          payload: payload("One"),
          settings: DEFAULT_SETTINGS,
          destinationId: null,
          profileId: DEFAULT_PROFILE_ID
        },
        {
          kind: "output",
          run: run("run-2", "queued"),
          payload: payload("Two"),
          settings: DEFAULT_SETTINGS,
          destinationId: null,
          profileId: DEFAULT_PROFILE_ID
        },
        { kind: "collecting", run: run("run-3", "collecting") }
      ]
    };

    expect(getGatherQueueDisplayRun(queue)).toMatchObject({
      id: "run-1",
      queuedCount: 2,
      progress: { message: "Writing Gather Output..." }
    });
  });

  it("restores collected jobs and drops malformed persisted entries", () => {
    const restored = GatherQueueStateSchema.parse({
      schemaVersion: GATHER_QUEUE_SCHEMA_VERSION,
      results: [],
      jobs: [
        {
          kind: "output",
          run: run("run-1", "queued"),
          payload: payload("One"),
          settings: DEFAULT_SETTINGS,
          destinationId: null,
          profileId: DEFAULT_PROFILE_ID
        },
        { run: { id: "broken" }, payload: null, settings: null }
      ]
    });

    expect(restored.jobs).toHaveLength(1);
    expect(restored.jobs[0]).toMatchObject({
      kind: "output",
      run: { id: "run-1" },
      payload: { title: "One" }
    });
  });

  it("keeps a collecting placeholder until page capture finishes", () => {
    const restored = GatherQueueStateSchema.parse({
      schemaVersion: GATHER_QUEUE_SCHEMA_VERSION,
      jobs: [{ run: run("run-1", "collecting"), payload: null, settings: null }]
    });

    expect(restored.jobs).toMatchObject([{ kind: "collecting", run: { phase: "collecting" } }]);
  });

  it("selects queued outputs in FIFO order only when no output is executing", () => {
    const queued: GatherQueueState = {
      schemaVersion: GATHER_QUEUE_SCHEMA_VERSION,
      batch: null,
      results: [],
      jobs: [
        {
          kind: "output",
          run: run("run-1", "queued"),
          payload: payload("One"),
          settings: DEFAULT_SETTINGS,
          destinationId: null,
          profileId: DEFAULT_PROFILE_ID
        },
        {
          kind: "output",
          run: run("run-2", "queued"),
          payload: payload("Two"),
          settings: DEFAULT_SETTINGS,
          destinationId: null,
          profileId: DEFAULT_PROFILE_ID
        }
      ]
    };

    expect(getNextQueuedGatherJob(queued)?.run.id).toBe("run-1");

    queued.jobs[0] = {
      kind: "output",
      run: run("run-1", "writing"),
      payload: payload("One"),
      settings: DEFAULT_SETTINGS,
      destinationId: null,
      profileId: DEFAULT_PROFILE_ID
    };
    expect(getNextQueuedGatherJob(queued)).toBeNull();
  });

  it("resumes folder permission by destination scope after the source tab closes", () => {
    const siteScoped: GatherQueueState = {
      schemaVersion: GATHER_QUEUE_SCHEMA_VERSION,
      batch: null,
      results: [],
      jobs: [
        {
          kind: "output",
          run: {
            ...run("run-1", "permission-required"),
            tabId: 7,
            tabUrl: "https://www.pixiv.net/artworks/old"
          },
          payload: payload("One"),
          settings: { ...DEFAULT_SETTINGS, useGlobalFolder: false },
          destinationId: null,
          profileId: DEFAULT_PROFILE_ID
        }
      ]
    };

    expect(getPermissionRequiredGatherJob(siteScoped, "pixiv", DEFAULT_PROFILE_ID)?.run.id).toBe(
      "run-1"
    );
    expect(getPermissionRequiredGatherJob(siteScoped, "reddit", DEFAULT_PROFILE_ID)).toBeNull();

    const firstJob = siteScoped.jobs[0];

    if (firstJob.kind !== "output") {
      throw new Error("Expected an output job.");
    }

    firstJob.settings = { ...DEFAULT_SETTINGS, useGlobalFolder: true };
    expect(getPermissionRequiredGatherJob(siteScoped, "reddit", DEFAULT_PROFILE_ID)?.run.id).toBe(
      "run-1"
    );

    // Another profile prompts for a different folder, so it cannot confirm this one.
    expect(getPermissionRequiredGatherJob(siteScoped, "reddit", "work")).toBeNull();
  });

  it("keeps each terminal result available while later jobs run", () => {
    const failed = {
      ...run("run-1", "writing"),
      phase: "failed" as const,
      updatedAt: 200,
      failedItems: [{ fileName: "missing.jpg", reason: "network" }],
      retryImages: [payload("One").images[0]]
    };

    const complete = {
      ...run("run-2", "writing"),
      phase: "complete" as const,
      updatedAt: 300
    };

    const queue: GatherQueueState = {
      schemaVersion: GATHER_QUEUE_SCHEMA_VERSION,
      batch: null,
      jobs: [
        {
          kind: "output",
          run: run("run-3", "writing"),
          payload: payload("Three"),
          settings: DEFAULT_SETTINGS,
          destinationId: null,
          profileId: DEFAULT_PROFILE_ID
        }
      ],
      results: [failed, complete]
    };

    expect(getLatestGatherQueueResult(queue)?.id).toBe("run-2");
    expect(getRetryableGatherQueueResult(queue)?.id).toBe("run-1");
    expect(GatherQueueStateSchema.parse(queue).results).toHaveLength(2);
  });

  it("requeues safe outputs and drops an interrupted page capture during recovery", () => {
    const queue: GatherQueueState = {
      schemaVersion: GATHER_QUEUE_SCHEMA_VERSION,
      batch: null,
      results: [],
      jobs: [
        {
          kind: "output",
          run: run("run-1", "writing"),
          payload: payload("One"),
          settings: DEFAULT_SETTINGS,
          destinationId: null,
          profileId: DEFAULT_PROFILE_ID
        },
        { kind: "collecting", run: run("run-2", "collecting") }
      ]
    };

    const recovered = recoverStoppedGatherQueue(queue, 500);
    expect(recovered.queue.jobs).toMatchObject([
      {
        run: {
          id: "run-1",
          phase: "queued",
          updatedAt: 500,
          progress: { message: "Recovered and queued after browser restart." }
        }
      }
    ]);
    expect(recovered.ended).toMatchObject([
      { id: "run-2", phase: "interrupted", updatedAt: 500 }
    ]);
  });

  it("keeps a cancelling job through storage and finishes the cancellation on restart", () => {
    const stored = GatherQueueStateSchema.parse({
      schemaVersion: GATHER_QUEUE_SCHEMA_VERSION,
      results: [],
      jobs: [
        {
          kind: "output",
          run: run("run-1", "cancelling"),
          payload: payload("One"),
          settings: DEFAULT_SETTINGS,
          destinationId: null,
          profileId: DEFAULT_PROFILE_ID
        },
        {
          kind: "output",
          run: run("run-2", "queued"),
          payload: payload("Two"),
          settings: DEFAULT_SETTINGS,
          destinationId: null,
          profileId: DEFAULT_PROFILE_ID
        }
      ]
    });

    expect(stored.jobs).toMatchObject([
      { run: { id: "run-1", phase: "cancelling" } },
      { run: { id: "run-2", phase: "queued" } }
    ]);
    expect(getNextQueuedGatherJob(stored)).toBeNull();

    const recovered = recoverStoppedGatherQueue(stored, 500);
    expect(recovered.queue.jobs).toMatchObject([{ run: { id: "run-2", phase: "queued" } }]);
    expect(recovered.ended).toMatchObject([{ id: "run-1", phase: "cancelled", updatedAt: 500 }]);
  });

  it("tallies every run that went through the queue together, listing only the latest", () => {
    // run-1 finishes with nothing else queued, so the queue empties and its batch closes.
    let queue = finish({ ...EMPTY_GATHER_QUEUE, jobs: [waiting("run-1", 0)] }, finished("run-1", 0, 10, 5));
    queue = { ...queue, jobs: Array.from({ length: 8 }, (_, index) => waiting(`run-${index + 2}`, 20)) };
    expect(getGatherQueueBatch(queue)).toMatchObject({ recent: [], pages: 0 });

    for (let index = 2; index <= 8; index += 1) {
      queue = finish(queue, finished(`run-${index}`, 20, 20 + index, 2));
    }

    expect(getGatherQueueBatch(queue)).toMatchObject({
      recent: [{ id: "run-8" }, { id: "run-7" }, { id: "run-6" }, { id: "run-5" }, { id: "run-4" }],
      pages: 7,
      saved: 14,
      skipped: 7,
      failed: 0
    });

    // Recording the last run again replaces it without counting it twice.
    queue = finish(queue, finished("run-9", 20, 40, 3));
    queue = finish(queue, finished("run-9", 20, 41, 3));
    expect(getGatherQueueBatch(queue)).toMatchObject({ pages: 8, saved: 17 });

    // Once the queue is idle, a page gathered later starts a batch of its own.
    queue = finish({ ...queue, jobs: [waiting("run-10", 50)] }, finished("run-10", 50, 60, 1));
    expect(getGatherQueueBatch(queue)).toMatchObject({ recent: [{ id: "run-10" }], pages: 1 });
  });

  it("keeps a retry in its batch and keeps retryable results past the cap", () => {
    let queue = finish(
      { ...EMPTY_GATHER_QUEUE, jobs: [waiting("run-1", 0), waiting("run-2", 0)] },
      finished("run-1", 0, 10, 4, 2)
    );

    for (let index = 2; index <= 12; index += 1) {
      queue = finish(queue, finished(`run-${index}`, 0, 10 + index, 1));
    }

    // run-1 fell out of the latest ten but still has failed items, so it stays without its log.
    expect(queue.results).toHaveLength(11);
    expect(getRetryableGatherQueueResult(queue)).toMatchObject({ id: "run-1", log: [] });

    // The queue is empty, so the batch is closed. Retrying run-1 opens it again.
    const retried = getRetryableGatherQueueResult(queue)!;
    queue = withdrawGatherQueueResult({ ...queue, jobs: [waiting("retry", 30)] }, retried);
    expect(getGatherQueueBatch(queue)).toMatchObject({ pages: 11, saved: 15, failed: 0 });

    queue = finish(queue, finished("retry", 30, 40, 2));
    expect(getGatherQueueBatch(queue)).toMatchObject({
      recent: [{ id: "retry" }, { id: "run-12" }, { id: "run-11" }, { id: "run-10" }, { id: "run-9" }],
      pages: 12,
      saved: 17,
      failed: 0
    });
  });
});
