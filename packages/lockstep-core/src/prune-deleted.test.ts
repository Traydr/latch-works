import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LockstepPlan, LockstepRunEvent } from "./types.js";

const mocks = vi.hoisted(() => ({
  deleteRemoteItem: vi.fn(),
  postJson: vi.fn(),
}));

vi.mock("./remote-api.js", () => ({
  deleteRemoteItem: mocks.deleteRemoteItem,
  postJson: mocks.postJson,
  pushMediaItem: vi.fn(),
}));

const { deleteRemoteItem, postJson } = mocks;

import { pruneDeleted } from "./prune-deleted.js";

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
    totalBytes: 0,
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

describe("pruneDeleted orchestration", () => {
  beforeEach(() => {
    postJson.mockReset();
    deleteRemoteItem.mockReset();
  });

  it("emits complete without creating a sync run when nothing to prune", async () => {
    const plan = createPlan([{ action: "keep", path: "photos/existing.jpg" }]);
    const { events, observer } = collectEvents();

    const result = await pruneDeleted(
      {
        apiToken: "token",
        apiUrl: "http://127.0.0.1:3000",
        plan,
        sourceRoot: plan.sourceRoot,
      },
      observer,
    );

    expect(result).toEqual({ failed: 0, plan, pruned: 0 });
    expect(postJson).not.toHaveBeenCalled();
    expect(deleteRemoteItem).not.toHaveBeenCalled();

    const complete = events.find((event) => event.type === "complete");
    expect(complete).toMatchObject({
      summary: {
        action: "prune",
        failed: 0,
        message: "Nothing to prune.",
        pushed: 0,
        status: "completed",
      },
    });
  });

  it("creates a sync run, deletes items, and finalizes as completed", async () => {
    const plan = createPlan([{ action: "delete", path: "photos/old.jpg" }]);

    postJson.mockResolvedValueOnce({ syncRunId: "run-1" });
    deleteRemoteItem.mockResolvedValueOnce(undefined);
    postJson.mockResolvedValueOnce({ status: "database" });

    const { events, observer } = collectEvents();

    const result = await pruneDeleted(
      {
        apiToken: "token",
        apiUrl: "http://127.0.0.1:3000",
        plan,
        sourceRoot: plan.sourceRoot,
      },
      observer,
    );

    expect(result).toEqual({ failed: 0, plan, pruned: 1 });
    expect(postJson).toHaveBeenCalledTimes(2);
    expect(deleteRemoteItem).toHaveBeenCalledWith(
      expect.objectContaining({
        logicalPath: "photos/old.jpg",
        syncRunId: "run-1",
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
        action: "prune",
        failed: 0,
        pushed: 1,
        status: "completed",
      },
    });
  });

  it("finalizes as failed and increments failed when a delete fails", async () => {
    const plan = createPlan([{ action: "delete", path: "photos/old.jpg" }]);

    postJson.mockResolvedValueOnce({ syncRunId: "run-1" });
    deleteRemoteItem.mockRejectedValueOnce(new Error("delete failed"));
    postJson.mockResolvedValueOnce({ status: "database" });

    const { events, observer } = collectEvents();

    const result = await pruneDeleted(
      {
        apiToken: "token",
        apiUrl: "http://127.0.0.1:3000",
        plan,
        sourceRoot: plan.sourceRoot,
      },
      observer,
    );

    expect(result.failed).toBe(1);
    expect(result.pruned).toBe(0);

    const finalizeCall = postJson.mock.calls.find((call) => String(call[1]).endsWith("/complete"));
    expect(finalizeCall?.[3]).toMatchObject({
      status: "failed",
      counts: expect.objectContaining({ failed: 1, pushed: 0 }),
    });

    const complete = events.find((event) => event.type === "complete");
    expect(complete).toMatchObject({
      summary: {
        action: "prune",
        failed: 1,
        status: "failed",
      },
    });
  });

  it("finalizes as cancelled and rethrows when aborted during a delete", async () => {
    const controller = new AbortController();
    const plan = createPlan([{ action: "delete", path: "photos/old.jpg" }]);

    postJson.mockResolvedValueOnce({ syncRunId: "run-1" });
    deleteRemoteItem.mockImplementation(async ({ signal }) => {
      controller.abort();
      throw signal?.reason ?? new DOMException("Aborted", "AbortError");
    });
    postJson.mockResolvedValueOnce({ status: "database" });

    const { events, observer } = collectEvents();

    await expect(
      pruneDeleted(
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
    expect(finalizeCall).toBeDefined();
    expect(finalizeCall?.[4]).toBeUndefined();
    expect(finalizeCall?.[3]).toMatchObject({
      error: "Run cancelled by user",
      status: "cancelled",
    });

    const complete = events.find((event) => event.type === "complete");
    expect(complete).toMatchObject({
      summary: {
        action: "prune",
        status: "cancelled",
      },
    });
  });
});
