import type { MediaItem } from "@latch-works/media-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LockstepPlan, LockstepRunEvent } from "./types.js";

const mocks = vi.hoisted(() => ({
  postJson: vi.fn(),
  pushMediaItem: vi.fn(),
}));

vi.mock("./remote-api.js", () => ({
  deleteRemoteItem: vi.fn(),
  postJson: mocks.postJson,
  pushMediaItem: mocks.pushMediaItem,
}));

const { postJson, pushMediaItem } = mocks;

import { pushChanges } from "./push-changes.js";

const localItem: MediaItem = {
  extension: "jpg",
  id: "media-1",
  mediaType: "image",
  mtimeMs: 1_700_000_000_000,
  name: "photo.jpg",
  parentPath: "photos",
  path: "photos/photo.jpg",
  sha256: "abc123",
  size: 1024,
};

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
    sourceRoot: "/tmp/archive",
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
  beforeEach(() => {
    postJson.mockReset();
    pushMediaItem.mockReset();
  });

  it("emits complete without creating a sync run when nothing changed", async () => {
    const plan = createPlan([{ action: "keep", path: "photos/existing.jpg" }]);
    const { events, observer } = collectEvents();

    const result = await pushChanges(
      {
        apiToken: "token",
        apiUrl: "http://127.0.0.1:3000",
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
