import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pruneDeleted } from "./prune-deleted.js";
import { UnfinalizedSyncRunError } from "./sync-run.js";
import { type FakePaneView, startFakePaneView } from "./testing.js";
import type { LockstepPlan, LockstepRunEvent } from "./types.js";

function createPlan(items: LockstepPlan["items"], sourceRoot: string): LockstepPlan {
  return {
    counts: {
      delete: items.filter((item) => item.action === "delete").length,
      keep: items.filter((item) => item.action === "keep").length,
      update: items.filter((item) => item.action === "update").length,
      upload: items.filter((item) => item.action === "upload").length,
    },
    items,
    skippedEntries: [],
    sourceRoot,
    totalBytes: 0,
    totalFiles: items.length,
  };
}

function deletes(...paths: string[]): LockstepPlan["items"] {
  return paths.map((archivePath) => ({ action: "delete", path: archivePath }));
}

async function writeSourceFile(sourceRoot: string, archivePath: string): Promise<void> {
  const filePath = path.join(sourceRoot, ...archivePath.split("/"));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "local bytes");
}

describe("pruneDeleted", () => {
  let paneView: FakePaneView;
  let sourceRoot: string;

  /** Starts Pane View holding an entry for every path the plan deletes. */
  async function serve(plan: LockstepPlan): Promise<void> {
    paneView = await startFakePaneView({
      entries: plan.items.map((item) => ({ path: item.path, size: 1 })),
    });
  }

  function prune(plan: LockstepPlan, options: { maxChanges?: number; signal?: AbortSignal } = {}) {
    const events: LockstepRunEvent[] = [];

    const result = pruneDeleted(
      { apiToken: paneView.apiToken, apiUrl: paneView.apiUrl, plan, ...options },
      { onEvent: (event) => events.push(event) },
    );

    return { events, result };
  }

  function remaining(): string[] {
    return [...paneView.library.keys()].sort();
  }

  beforeEach(async () => {
    sourceRoot = await mkdtemp(path.join(os.tmpdir(), "lockstep-prune-"));
  });

  afterEach(async () => {
    await paneView.close();
    await rm(sourceRoot, { force: true, recursive: true });
    await rm(`${sourceRoot}-moved`, { force: true, recursive: true });
  });

  it("creates no sync run when nothing is to prune", async () => {
    const plan = createPlan([{ action: "keep", path: "photos/existing.jpg" }], sourceRoot);
    await serve(plan);

    await expect(prune(plan).result).resolves.toEqual({
      action: "prune",
      applied: 0,
      failed: 0,
      skipped: 0,
      status: "completed",
    });
    expect(paneView.requests).toEqual([]);
  });

  it("deletes the remote entries and finalizes the run as completed", async () => {
    const plan = createPlan(deletes("photos/old.jpg"), sourceRoot);
    await serve(plan);

    await expect(prune(plan).result).resolves.toEqual({
      action: "prune",
      applied: 1,
      failed: 0,
      skipped: 0,
      status: "completed",
    });
    expect(remaining()).toEqual([]);
    expect(paneView.runs[0]?.outcome).toMatchObject({
      counts: { failed: 0, pushed: 1 },
      status: "completed",
    });
  });

  it("finalizes the run as failed when a delete fails", async () => {
    const plan = createPlan(deletes("photos/old.jpg"), sourceRoot);
    await serve(plan);
    paneView.intercept((request) => (request.route === "delete" ? { status: 500 } : undefined));

    await expect(prune(plan).result).resolves.toMatchObject({ applied: 0, failed: 1 });
    expect(remaining()).toEqual(["photos/old.jpg"]);
    expect(paneView.runs[0]?.outcome).toMatchObject({
      counts: { failed: 1, pushed: 0 },
      status: "failed",
    });
  });

  it("finalizes the run as cancelled and rethrows when cancelled during a delete", async () => {
    const plan = createPlan(deletes("photos/old.jpg"), sourceRoot);
    await serve(plan);
    const controller = new AbortController();

    paneView.intercept((request) => {
      if (request.route !== "delete") return undefined;
      controller.abort();

      return "hold";
    });

    await expect(prune(plan, { signal: controller.signal }).result).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(paneView.runs[0]?.outcome).toMatchObject({
      error: "Run cancelled by user",
      status: "cancelled",
    });
  });

  it("deletes exactly the reviewed plan's deletes and skips paths that reappeared locally", async () => {
    // Files that are not in the plan at all must not matter: prune never plans again.
    await writeSourceFile(sourceRoot, "photos/new-upload.jpg");
    await writeSourceFile(sourceRoot, "photos/back-again.jpg");

    const plan = createPlan(
      [
        { action: "delete", path: "photos/gone-1.jpg" },
        { action: "keep", path: "photos/kept.jpg" },
        { action: "delete", path: "photos/back-again.jpg" },
        { action: "upload", path: "photos/new-upload.jpg" },
        { action: "delete", path: "photos/gone-2.jpg" },
      ],
      sourceRoot,
    );

    await serve(plan);
    const { events, result } = prune(plan);

    await expect(result).resolves.toEqual({
      action: "prune",
      applied: 2,
      failed: 0,
      skipped: 1,
      status: "completed",
    });
    expect(remaining()).toEqual([
      "photos/back-again.jpg",
      "photos/kept.jpg",
      "photos/new-upload.jpg",
    ]);
    expect(events.filter((event) => event.type === "item-skipped")).toEqual([
      {
        type: "item-skipped",
        action: "delete",
        current: 2,
        path: "photos/back-again.jpg",
        reason: "the file is back in the source folder",
        total: 3,
      },
    ]);
  });

  it("applies only the first max-changes deletes of the reviewed plan", async () => {
    const plan = createPlan(deletes("a.jpg", "b.jpg", "c.jpg"), sourceRoot);
    await serve(plan);

    await expect(prune(plan, { maxChanges: 2 }).result).resolves.toMatchObject({ applied: 2 });
    expect(remaining()).toEqual(["c.jpg"]);
  });

  it("refuses to prune when the source folder is missing", async () => {
    const plan = createPlan(deletes("a.jpg"), path.join(sourceRoot, "unmounted-drive"));
    await serve(plan);

    await expect(prune(plan).result).rejects.toThrow(/Source folder is not available/);
    expect(paneView.requests).toEqual([]);
  });

  it("skips a delete whose file came back under an equivalent name", async () => {
    await writeSourceFile(sourceRoot, "photos/restored.jpeg");
    await writeSourceFile(sourceRoot, "Photos/Recased.JPG");

    const plan = createPlan(
      deletes("photos/restored.jpg", "photos/recased.jpg", "photos/gone.jpg"),
      sourceRoot,
    );

    await serve(plan);

    await expect(prune(plan).result).resolves.toMatchObject({ applied: 1, failed: 0, skipped: 2 });
    expect(remaining()).toEqual(["photos/recased.jpg", "photos/restored.jpg"]);
  });

  it("skips a delete whose alias was restored after its folder was already checked", async () => {
    // Pretend the folder last changed long ago so its listing is reused between deletes.
    vi.useFakeTimers({ now: Date.now() + 60_000, toFake: ["Date"] });
    await writeSourceFile(sourceRoot, "photos/kept.jpg");

    const plan = createPlan(
      [
        { action: "keep", path: "photos/kept.jpg" },
        ...deletes("photos/first.jpg", "photos/second.jpg"),
      ],
      sourceRoot,
    );

    await serve(plan);

    paneView.intercept(async (request) => {
      if (request.route === "delete" && request.path === "photos/first.jpg") {
        await writeSourceFile(sourceRoot, "photos/second.jpeg");
      }

      return undefined;
    });

    try {
      await expect(prune(plan).result).resolves.toMatchObject({
        applied: 1,
        failed: 0,
        skipped: 1,
      });
      expect(remaining()).toEqual(["photos/kept.jpg", "photos/second.jpg"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still deletes a jpeg twin when its jpg sibling was already in the plan", async () => {
    await writeSourceFile(sourceRoot, "photos/photo.jpg");

    const plan = createPlan(
      [{ action: "keep", path: "photos/photo.jpg" }, ...deletes("photos/photo.jpeg")],
      sourceRoot,
    );

    await serve(plan);

    await expect(prune(plan).result).resolves.toMatchObject({ applied: 1, failed: 0, skipped: 0 });
    expect(remaining()).toEqual(["photos/photo.jpg"]);
  });

  it("stops without deleting when the source folder disappears mid-run", async () => {
    const plan = createPlan(deletes("photos/back.jpg"), sourceRoot);
    await serve(plan);

    paneView.intercept(async (request) => {
      if (request.route === "createRun") await rename(sourceRoot, `${sourceRoot}-moved`);

      return undefined;
    });

    await expect(prune(plan).result).rejects.toThrow(/Source folder is not available/);
    expect(remaining()).toEqual(["photos/back.jpg"]);
    expect(paneView.runs[0]?.outcome).toMatchObject({ status: "failed" });
  });

  it("stops without deleting when the source folder is replaced by an empty one", async () => {
    const plan = createPlan(deletes("photos/back.jpg"), sourceRoot);
    await serve(plan);

    paneView.intercept(async (request) => {
      if (request.route === "createRun") {
        await rename(sourceRoot, `${sourceRoot}-moved`);
        await mkdir(sourceRoot);
      }

      return undefined;
    });

    await expect(prune(plan).result).rejects.toThrow(/Source folder is not available/);
    expect(remaining()).toEqual(["photos/back.jpg"]);
  });

  it("fails the prune when the sync run cannot be finalized", async () => {
    const plan = createPlan(deletes("photos/old.jpg"), sourceRoot);
    await serve(plan);
    paneView.intercept((request) =>
      request.route === "completeRun" ? { status: 503 } : undefined,
    );

    await expect(prune(plan).result).rejects.toThrow(/sync run run-1 could not be finalized/);
    expect(remaining()).toEqual([]);
  });

  it("names the unfinalized run when a cancelled prune cannot be finalized", async () => {
    const plan = createPlan(deletes("photos/old.jpg"), sourceRoot);
    await serve(plan);
    const controller = new AbortController();
    const reason = new DOMException("user cancelled", "AbortError");

    paneView.intercept((request) => {
      if (request.route === "completeRun") return { status: 503 };

      if (request.route !== "delete") return undefined;
      controller.abort(reason);

      return "hold";
    });

    const error = await prune(plan, { signal: controller.signal }).result.catch((cause) => cause);

    expect(error).toBeInstanceOf(UnfinalizedSyncRunError);
    expect(error).toMatchObject({
      action: "prune",
      cause: reason,
      intendedStatus: "cancelled",
      message: expect.stringMatching(/cancelled.*sync run run-1 could not be finalized/),
      syncRunId: "run-1",
    });
  });

  it("names the unfinalized run when the source folder goes away and finalizing fails", async () => {
    const plan = createPlan(deletes("photos/back.jpg"), sourceRoot);
    await serve(plan);

    paneView.intercept(async (request) => {
      if (request.route === "completeRun") return { status: 503 };

      if (request.route === "createRun") await rename(sourceRoot, `${sourceRoot}-moved`);

      return undefined;
    });

    const error = await prune(plan).result.catch((cause) => cause);

    expect(remaining()).toEqual(["photos/back.jpg"]);
    expect(error).toBeInstanceOf(UnfinalizedSyncRunError);
    expect(error).toMatchObject({
      cause: { name: "SourceRootUnavailableError" },
      intendedStatus: "failed",
      message: expect.stringMatching(/Source folder is not available.*sync run run-1/),
      syncRunId: "run-1",
    });
  });

  it("finalizes a run created while the prune was being cancelled", async () => {
    const plan = createPlan(deletes("photos/old.jpg"), sourceRoot);
    await serve(plan);
    const controller = new AbortController();

    paneView.intercept(async (request) => {
      if (request.route !== "createRun") return undefined;
      controller.abort();
      // The run is committed, but its id reaches the client only after the cancel.
      await delay(50);

      return undefined;
    });

    await expect(prune(plan, { signal: controller.signal }).result).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(remaining()).toEqual(["photos/old.jpg"]);
    expect(paneView.runs[0]?.outcome).toMatchObject({ counts: { pushed: 0 }, status: "cancelled" });
  });
});
