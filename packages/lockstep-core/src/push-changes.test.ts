import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  detectMediaType,
  getBaseName,
  getExtension,
  getParentPath,
  type MediaItem,
} from "@latch-works/media-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pushChanges } from "./push-changes.js";
import { UnfinalizedSyncRunError } from "./sync-run.js";
import { type FakePaneView, startFakePaneView } from "./testing.js";
import type { LockstepPlan, LockstepRunEvent } from "./types.js";

let cacheRoot: string;

let paneView: FakePaneView;

let sourceRoot: string;

let tempDir: string;

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Writes a file into the source folder and returns it as the scan reports it, unhashed. */
async function localFile(archivePath: string, content: string): Promise<MediaItem> {
  const filePath = path.join(sourceRoot, ...archivePath.split("/"));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  const { mtimeMs, size } = await stat(filePath);

  return {
    extension: getExtension(archivePath),
    id: archivePath,
    mediaType: detectMediaType(archivePath),
    mtimeMs: Math.trunc(mtimeMs),
    name: getBaseName(archivePath),
    parentPath: getParentPath(archivePath),
    path: archivePath,
    size,
  };
}

function uploads(...items: MediaItem[]): LockstepPlan["items"] {
  return items.map((local) => ({ action: "upload", local, path: local.path }));
}

function createPlan(items: LockstepPlan["items"]): LockstepPlan {
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

function push(plan: LockstepPlan, options: { maxChanges?: number; signal?: AbortSignal } = {}) {
  const events: LockstepRunEvent[] = [];

  const result = pushChanges(
    {
      apiToken: paneView.apiToken,
      apiUrl: paneView.apiUrl,
      hashCacheRoot: cacheRoot,
      plan,
      uploadConcurrency: 3,
      ...options,
    },
    { onEvent: (event) => events.push(event) },
  );

  return { events, result };
}

function libraryHashes(): Record<string, string | undefined> {
  return Object.fromEntries([...paneView.library].map(([key, entry]) => [key, entry.sha256]));
}

describe("pushChanges", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "lockstep-push-changes-"));
    sourceRoot = path.join(tempDir, "archive");
    cacheRoot = path.join(tempDir, "cache");
    await mkdir(sourceRoot, { recursive: true });
    paneView = await startFakePaneView();
  });

  afterEach(async () => {
    await paneView.close();
    await rm(tempDir, { force: true, recursive: true });
  });

  it("creates no sync run when nothing changed", async () => {
    const plan = createPlan([{ action: "keep", path: "photos/existing.jpg" }]);

    await expect(push(plan).result).resolves.toEqual({
      action: "push",
      applied: 0,
      failed: 0,
      skipped: 0,
      status: "completed",
    });
    expect(paneView.requests).toEqual([]);
  });

  it("uploads and registers each change, then finalizes the run as completed", async () => {
    const plan = createPlan(uploads(await localFile("photos/photo.jpg", "photo bytes")));

    await expect(push(plan).result).resolves.toEqual({
      action: "push",
      applied: 1,
      failed: 0,
      skipped: 0,
      status: "completed",
    });
    expect(libraryHashes()).toEqual({ "photos/photo.jpg": sha256("photo bytes") });
    expect([...paneView.objects.values()].map((bytes) => bytes.toString())).toEqual([
      "photo bytes",
    ]);
    expect(paneView.runs).toEqual([
      {
        outcome: {
          counts: { ...plan.counts, capped: 1, failed: 0, planned: 1, pushed: 1 },
          status: "completed",
        },
        started: { counts: plan.counts, sourceRoot },
        syncRunId: "run-1",
      },
    ]);
  });

  it("registers an update at the remote path when only case and the jpeg alias differ", async () => {
    paneView.library.set("Photos/Cover.jpeg", { path: "Photos/Cover.jpeg", size: 3 });
    const local = await localFile("photos/cover.jpg", "new");

    const plan = createPlan([
      { action: "update", local, path: local.path, remote: { path: "Photos/Cover.jpeg", size: 3 } },
    ]);

    await push(plan).result;

    expect(libraryHashes()).toEqual({ "Photos/Cover.jpeg": sha256("new") });
  });

  it("pushes only the first max-changes changes of the plan", async () => {
    const plan = createPlan(
      uploads(await localFile("a.jpg", "first"), await localFile("b.jpg", "second")),
    );

    await expect(push(plan, { maxChanges: 1 }).result).resolves.toMatchObject({ applied: 1 });
    expect([...paneView.library.keys()]).toEqual(["a.jpg"]);
    expect(paneView.runs[0]?.outcome?.counts).toMatchObject({ capped: 1, planned: 2, pushed: 1 });
  });

  it("fails an item the upload refuses, carries on, and finalizes the run as failed", async () => {
    paneView.intercept((request) =>
      request.route === "upload" && request.path?.includes(sha256("second"))
        ? { status: 500 }
        : undefined,
    );

    const plan = createPlan(
      uploads(
        await localFile("a.jpg", "first"),
        await localFile("b.jpg", "second"),
        await localFile("c.jpg", "third"),
      ),
    );

    const { events, result } = push(plan);

    await expect(result).resolves.toEqual({
      action: "push",
      applied: 2,
      failed: 1,
      skipped: 0,
      status: "failed",
    });
    expect([...paneView.library.keys()].sort()).toEqual(["a.jpg", "c.jpg"]);
    expect(events.filter((event) => event.type === "item-failure")).toMatchObject([
      { path: "b.jpg" },
    ]);
    expect(paneView.runs[0]?.outcome).toMatchObject({
      counts: { failed: 1, pushed: 2 },
      error: "1 item(s) failed during push",
      status: "failed",
    });
  });

  it("fails an item whose file changed after planning", async () => {
    const local = await localFile("a.jpg", "planned");
    await writeFile(path.join(sourceRoot, "a.jpg"), "changed since");

    await expect(push(createPlan(uploads(local))).result).resolves.toMatchObject({
      applied: 0,
      failed: 1,
    });
    expect(paneView.library.size).toBe(0);
  });

  it("finalizes the run as cancelled and rethrows when cancelled during an item", async () => {
    const controller = new AbortController();

    paneView.intercept((request) => {
      if (request.route !== "uploadUrl") return undefined;
      controller.abort();

      return "hold";
    });

    const plan = createPlan(uploads(await localFile("a.jpg", "first")));

    await expect(push(plan, { signal: controller.signal }).result).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(paneView.library.size).toBe(0);
    expect(paneView.runs[0]?.outcome).toMatchObject({
      error: "Run cancelled by user",
      status: "cancelled",
    });
  });

  it("starts no new upload after a cancel and waits for the ones in flight", async () => {
    const controller = new AbortController();
    paneView.intercept((request) => (request.route === "uploadUrl" ? "hold" : undefined));

    const items = [];

    for (const name of ["a", "b", "c", "d", "e"]) {
      items.push(await localFile(`${name}.jpg`, name));
    }

    const { result } = push(createPlan(uploads(...items)), { signal: controller.signal });
    const registrations = () => paneView.requests.filter(({ route }) => route === "uploadUrl");
    await vi.waitFor(() => expect(registrations()).toHaveLength(3));
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(registrations()).toHaveLength(3);
    expect(paneView.runs[0]?.outcome).toMatchObject({ status: "cancelled" });
  });

  it("retries finalization and reports completion once it lands", async () => {
    let attempts = 0;

    paneView.intercept((request) => {
      if (request.route !== "completeRun") return undefined;
      attempts += 1;

      return attempts === 1 ? { status: 503 } : undefined;
    });

    const { events, result } = push(createPlan(uploads(await localFile("a.jpg", "first"))));

    await expect(result).resolves.toMatchObject({ applied: 1, status: "completed" });
    expect(paneView.runs[0]?.outcome).toMatchObject({ status: "completed" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "warning",
        message: expect.stringContaining("failed to finalize sync run, retrying"),
      }),
    );
  });

  it("fails the push when the sync run cannot be finalized", async () => {
    paneView.intercept((request) =>
      request.route === "completeRun" ? { status: 503 } : undefined,
    );

    await expect(
      push(createPlan(uploads(await localFile("a.jpg", "first")))).result,
    ).rejects.toThrow(/sync run run-1 could not be finalized.*503/);
    expect([...paneView.library.keys()]).toEqual(["a.jpg"]);
    expect(paneView.runs[0]?.outcome).toBeUndefined();
  });

  it("names the unfinalized run when a cancelled push cannot be finalized", async () => {
    const controller = new AbortController();
    const reason = new DOMException("user cancelled", "AbortError");

    paneView.intercept((request) => {
      if (request.route === "completeRun") return { status: 503 };

      if (request.route !== "uploadUrl") return undefined;
      controller.abort(reason);

      return "hold";
    });

    const plan = createPlan(uploads(await localFile("a.jpg", "first")));
    const error = await push(plan, { signal: controller.signal }).result.catch((cause) => cause);

    expect(error).toBeInstanceOf(UnfinalizedSyncRunError);
    expect(error).toMatchObject({
      action: "push",
      cause: reason,
      intendedStatus: "cancelled",
      syncRunId: "run-1",
    });
  });

  it("finalizes a run created while the push was being cancelled", async () => {
    const controller = new AbortController();

    paneView.intercept(async (request) => {
      if (request.route !== "createRun") return undefined;
      controller.abort();
      // The run is committed, but its id reaches the client only after the cancel.
      await delay(50);

      return undefined;
    });

    const plan = createPlan(uploads(await localFile("a.jpg", "first")));

    await expect(push(plan, { signal: controller.signal }).result).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(paneView.library.size).toBe(0);
    expect(paneView.runs[0]?.outcome).toMatchObject({
      counts: { pushed: 0 },
      status: "cancelled",
    });
  });
});
