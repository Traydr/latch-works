import { describe, expect, it } from "vitest";
import { createGatherRunState } from "./gather-run";
import {
  GATHER_QUEUE_SCHEMA_VERSION,
  getGatherQueueDisplayRun,
  getLatestGatherQueueResult,
  getRetryableGatherQueueResult,
  getNextQueuedGatherJob,
  getPermissionRequiredGatherJob,
  normalizeGatherQueueState,
  recoverStoppedGatherQueue,
  type GatherQueueState
} from "./gather-queue";
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

function run<TPhase extends "collecting" | "queued" | "writing" | "permission-required">(
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
  } as ReturnType<typeof createGatherRunState> & { phase: TPhase };
}

describe("Gather queue state", () => {
  it("keeps the executing job visible and reports pending jobs", () => {
    const queue: GatherQueueState = {
      schemaVersion: GATHER_QUEUE_SCHEMA_VERSION,
      results: [],
      jobs: [
        {
          kind: "output",
          run: run("run-1", "writing"),
          payload: payload("One"),
          settings: DEFAULT_SETTINGS
        },
        {
          kind: "output",
          run: run("run-2", "queued"),
          payload: payload("Two"),
          settings: DEFAULT_SETTINGS
        },
        { kind: "collecting", run: run("run-3", "collecting") }
      ]
    };

    expect(getGatherQueueDisplayRun(queue)).toMatchObject({
      id: "run-1",
      queuedCount: 2,
      progress: { message: "Writing Gather Output... · 2 queued" }
    });
  });

  it("restores collected jobs and drops malformed persisted entries", () => {
    const restored = normalizeGatherQueueState({
      schemaVersion: GATHER_QUEUE_SCHEMA_VERSION,
      results: [],
      jobs: [
        {
          kind: "output",
          run: run("run-1", "queued"),
          payload: payload("One"),
          settings: DEFAULT_SETTINGS
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
    const restored = normalizeGatherQueueState({
      schemaVersion: GATHER_QUEUE_SCHEMA_VERSION,
      jobs: [{ run: run("run-1", "collecting"), payload: null, settings: null }]
    });

    expect(restored.jobs).toMatchObject([{ kind: "collecting", run: { phase: "collecting" } }]);
  });

  it("selects queued outputs in FIFO order only when no output is executing", () => {
    const queued: GatherQueueState = {
      schemaVersion: GATHER_QUEUE_SCHEMA_VERSION,
      results: [],
      jobs: [
        {
          kind: "output",
          run: run("run-1", "queued"),
          payload: payload("One"),
          settings: DEFAULT_SETTINGS
        },
        {
          kind: "output",
          run: run("run-2", "queued"),
          payload: payload("Two"),
          settings: DEFAULT_SETTINGS
        }
      ]
    };
    expect(getNextQueuedGatherJob(queued)?.run.id).toBe("run-1");

    queued.jobs[0] = {
      kind: "output",
      run: run("run-1", "writing"),
      payload: payload("One"),
      settings: DEFAULT_SETTINGS
    };
    expect(getNextQueuedGatherJob(queued)).toBeNull();
  });

  it("resumes folder permission by destination scope after the source tab closes", () => {
    const siteScoped: GatherQueueState = {
      schemaVersion: GATHER_QUEUE_SCHEMA_VERSION,
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
          settings: { ...DEFAULT_SETTINGS, useGlobalFolder: false }
        }
      ]
    };

    expect(getPermissionRequiredGatherJob(siteScoped, "pixiv")?.run.id).toBe("run-1");
    expect(getPermissionRequiredGatherJob(siteScoped, "reddit")).toBeNull();

    const firstJob = siteScoped.jobs[0];
    if (firstJob.kind !== "output") {
      throw new Error("Expected an output job.");
    }
    firstJob.settings = { ...DEFAULT_SETTINGS, useGlobalFolder: true };
    expect(getPermissionRequiredGatherJob(siteScoped, "reddit")?.run.id).toBe("run-1");
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
      jobs: [
        {
          kind: "output",
          run: run("run-3", "writing"),
          payload: payload("Three"),
          settings: DEFAULT_SETTINGS
        }
      ],
      results: [failed, complete]
    };

    expect(getLatestGatherQueueResult(queue)?.id).toBe("run-2");
    expect(getRetryableGatherQueueResult(queue)?.id).toBe("run-1");
    expect(normalizeGatherQueueState(queue).results).toHaveLength(2);
  });

  it("requeues safe outputs and drops an interrupted page capture during recovery", () => {
    const queue: GatherQueueState = {
      schemaVersion: GATHER_QUEUE_SCHEMA_VERSION,
      results: [],
      jobs: [
        {
          kind: "output",
          run: run("run-1", "writing"),
          payload: payload("One"),
          settings: DEFAULT_SETTINGS
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
    expect(recovered.interrupted).toMatchObject([
      { id: "run-2", phase: "interrupted", updatedAt: 500 }
    ]);
  });
});
