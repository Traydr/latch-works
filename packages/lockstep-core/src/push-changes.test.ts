import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MediaItem } from "@latch-works/media-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LockstepPlan, LockstepRunEvent } from "./types.js";

const mocks = vi.hoisted(() => ({
  hashLocalFile: vi.fn(),
  postJson: vi.fn(),
  pushMediaItem: vi.fn(),
}));

vi.mock("./remote-api.js", () => ({
  deleteRemoteItem: vi.fn(),
  hashLocalFile: mocks.hashLocalFile,
  postJson: mocks.postJson,
  pushMediaItem: mocks.pushMediaItem,
}));

const { hashLocalFile, postJson, pushMediaItem } = mocks;

import { pushChanges } from "./push-changes.js";

let cacheRoot: string;
let localItem: MediaItem;
let sourceRoot: string;
let tempDir: string;

function createPlan(items: LockstepPlan["items"]): LockstepPlan {
  return {
    counts: {
      delete: items.filter((item) => item.action === "delete").length,
      keep: items.filter((item) => item.action === "keep").length,
      update: items.filter((item) => item.action === "update").length,
      upload: items.filter((item) => item.action === "upload").length,
    },
    items,
    skipped: 0,
    skippedEntries: [],
    sourceRoot,
    totalBytes: 1024,
    totalFiles: items.length,
  };
}

function collectEvents() {
  const events: LockstepRunEvent[] = [];
  return {
    events,
    observer: {
      onEvent: (event: LockstepRunEvent) => {
        events.push(event);
      },
    },
  };
}

describe("pushChanges orchestration", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "lockstep-push-changes-"));
    sourceRoot = path.join(tempDir, "archive");
    cacheRoot = path.join(tempDir, "cache");
    await mkdir(path.join(sourceRoot, "photos"), { recursive: true });
    const content = Buffer.alloc(1024, 1);
    const filePath = path.join(sourceRoot, "photos", "photo.jpg");
    await writeFile(filePath, content);
    const fileStat = await stat(filePath);
    const sha256 = createHash("sha256").update(content).digest("hex");
    localItem = {
      extension: "jpg",
      id: sha256,
      mediaType: "image",
      mtimeMs: Math.trunc(fileStat.mtimeMs),
      name: "photo.jpg",
      parentPath: "photos",
      path: "photos/photo.jpg",
      sha256,
      size: content.length,
    };
    postJson.mockReset();
    pushMediaItem.mockReset();
    hashLocalFile.mockReset();
    hashLocalFile.mockResolvedValue(sha256);
  });

  afterEach(async () => {
    await rm(tempDir, { force: true, recursive: true });
  });

  it("emits complete without creating a sync run when nothing changed", async () => {
    const plan = createPlan([{ action: "keep", path: "photos/existing.jpg" }]);
    const { events, observer } = collectEvents();

    const result = await pushChanges(
      {
        apiToken: "token",
        apiUrl: "http://127.0.0.1:3000",
        hashCacheRoot: cacheRoot,
        plan,
        sourceRoot: plan.sourceRoot,
      },
      observer,
    );

    expect(result).toEqual({ failed: 0, plan, pushed: 0 });
    expect(postJson).not.toHaveBeenCalled();
    expect(pushMediaItem).not.toHaveBeenCalled();

    const complete = events.find((event) => event.type === "complete");
    expect(complete).toMatchObject({
      summary: {
        action: "push",
        failed: 0,
        message: "Nothing to push.",
        pushed: 0,
        status: "completed",
      },
    });
  });

  it("creates a sync run, pushes items, and finalizes as completed", async () => {
    const plan = createPlan([{ action: "upload", local: localItem, path: localItem.path }]);

    postJson.mockResolvedValueOnce({ syncRunId: "run-1" });
    pushMediaItem.mockResolvedValueOnce(undefined);
    postJson.mockResolvedValueOnce({ status: "database" });

    const { events, observer } = collectEvents();

    const result = await pushChanges(
      {
        apiToken: "token",
        apiUrl: "http://127.0.0.1:3000",
        hashCacheRoot: cacheRoot,
        plan,
        sourceRoot: plan.sourceRoot,
      },
      observer,
    );

    expect(result).toEqual({ failed: 0, plan, pushed: 1 });
    expect(postJson).toHaveBeenCalledTimes(2);
    expect(postJson).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:3000",
      "/api/sync/runs",
      "token",
      {
        counts: plan.counts,
        sourceRoot: plan.sourceRoot,
      },
      undefined,
    );
    expect(pushMediaItem).toHaveBeenCalledTimes(1);
    expect(pushMediaItem).toHaveBeenCalledWith(
      expect.objectContaining({
        syncRunId: "run-1",
        item: localItem,
      }),
    );

    const finalizeCall = postJson.mock.calls.find((call) => String(call[1]).endsWith("/complete"));
    expect(finalizeCall?.[3]).toMatchObject({
      status: "completed",
      counts: expect.objectContaining({ failed: 0, pushed: 1 }),
    });

    const complete = events.find((event) => event.type === "complete");
    expect(complete).toMatchObject({
      summary: {
        action: "push",
        failed: 0,
        pushed: 1,
        status: "completed",
      },
    });
  });

  it("hashes only upload/update items selected by maxChanges", async () => {
    const secondPath = path.join(sourceRoot, "photos", "second.jpg");
    await writeFile(secondPath, Buffer.alloc(1024, 2));
    const secondStat = await stat(secondPath);
    const secondItem: MediaItem = {
      ...localItem,
      id: "second",
      mtimeMs: Math.trunc(secondStat.mtimeMs),
      name: "second.jpg",
      path: "photos/second.jpg",
      sha256: undefined,
    };
    const plan = createPlan([
      { action: "upload", local: localItem, path: localItem.path },
      { action: "upload", local: secondItem, path: secondItem.path },
    ]);
    postJson.mockResolvedValueOnce({ syncRunId: "run-1" });
    pushMediaItem.mockResolvedValueOnce(undefined);
    postJson.mockResolvedValueOnce({ status: "database" });

    const result = await pushChanges({
      apiToken: "token",
      apiUrl: "http://127.0.0.1:3000",
      hashCacheRoot: cacheRoot,
      maxChanges: 1,
      plan,
      sourceRoot: plan.sourceRoot,
    });

    expect(result.pushed).toBe(1);
    expect(hashLocalFile).toHaveBeenCalledTimes(1);
    expect(pushMediaItem).toHaveBeenCalledTimes(1);
    expect(pushMediaItem).toHaveBeenCalledWith(
      expect.objectContaining({ item: expect.objectContaining({ path: localItem.path }) }),
    );
  });

  it("finalizes as failed and increments failed when an item fails", async () => {
    const plan = createPlan([{ action: "upload", local: localItem, path: localItem.path }]);

    postJson.mockResolvedValueOnce({ syncRunId: "run-1" });
    pushMediaItem.mockRejectedValueOnce(new Error("upload failed"));
    postJson.mockResolvedValueOnce({ status: "database" });

    const { events, observer } = collectEvents();

    const result = await pushChanges(
      {
        apiToken: "token",
        apiUrl: "http://127.0.0.1:3000",
        hashCacheRoot: cacheRoot,
        plan,
        sourceRoot: plan.sourceRoot,
      },
      observer,
    );

    expect(result.failed).toBe(1);
    expect(result.pushed).toBe(0);

    const finalizeCall = postJson.mock.calls.find((call) => String(call[1]).endsWith("/complete"));
    expect(finalizeCall?.[3]).toMatchObject({
      status: "failed",
      counts: expect.objectContaining({ failed: 1, pushed: 0 }),
    });

    const complete = events.find((event) => event.type === "complete");
    expect(complete).toMatchObject({
      summary: {
        action: "push",
        failed: 1,
        status: "failed",
      },
    });
  });

  it("finalizes as cancelled and rethrows when aborted during an item", async () => {
    const controller = new AbortController();
    const plan = createPlan([{ action: "upload", local: localItem, path: localItem.path }]);

    postJson.mockResolvedValueOnce({ syncRunId: "run-1" });
    pushMediaItem.mockImplementation(async ({ signal }) => {
      controller.abort();
      throw signal?.reason ?? new DOMException("Aborted", "AbortError");
    });
    postJson.mockResolvedValueOnce({ status: "database" });

    const { events, observer } = collectEvents();

    await expect(
      pushChanges(
        {
          apiToken: "token",
          apiUrl: "http://127.0.0.1:3000",
          hashCacheRoot: cacheRoot,
          plan,
          signal: controller.signal,
          sourceRoot: plan.sourceRoot,
        },
        observer,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    const finalizeCall = postJson.mock.calls.find((call) => String(call[1]).endsWith("/complete"));
    expect(finalizeCall?.[3]).toMatchObject({
      error: "Run cancelled by user",
      status: "cancelled",
    });

    const complete = events.find((event) => event.type === "complete");
    expect(complete).toMatchObject({
      summary: {
        action: "push",
        status: "cancelled",
      },
    });
  });
});
