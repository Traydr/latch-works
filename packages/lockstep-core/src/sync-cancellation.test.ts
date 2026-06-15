import type { MediaItem } from "@latch-works/media-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LockstepPlan, LockstepRunEvent } from "./types.js";

const mocks = vi.hoisted(() => ({
  deleteRemoteItem: vi.fn(),
  postJson: vi.fn(),
  pushMediaItem: vi.fn(),
}));

vi.mock("./remote-api.js", () => ({
  deleteRemoteItem: mocks.deleteRemoteItem,
  postJson: mocks.postJson,
  pushMediaItem: mocks.pushMediaItem,
}));

const { deleteRemoteItem, postJson, pushMediaItem } = mocks;

import { pruneDeleted } from "./prune-deleted.js";
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
      keep: 0,
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

function collectEvents(observer?: { onEvent: (event: LockstepRunEvent) => void }) {
  const events: LockstepRunEvent[] = [];
  return {
    events,
    observer: {
      onEvent: (event: LockstepRunEvent) => {
        events.push(event);
        observer?.onEvent(event);
      },
    },
  };
}

describe("pushChanges cancellation", () => {
  beforeEach(() => {
    postJson.mockReset();
    pushMediaItem.mockReset();
  });

  it("finalizes cancelled push runs without reusing the aborted signal", async () => {
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
    expect(finalizeCall).toBeDefined();
    expect(finalizeCall?.[4]).toBeUndefined();
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

  it("still finalizes failed push runs as failed", async () => {
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
    const finalizeCall = postJson.mock.calls.find((call) => String(call[1]).endsWith("/complete"));
    expect(finalizeCall?.[3]).toMatchObject({
      status: "failed",
    });

    const complete = events.find((event) => event.type === "complete");
    expect(complete).toMatchObject({
      summary: {
        action: "push",
        status: "failed",
      },
    });
  });
});

describe("pruneDeleted cancellation", () => {
  beforeEach(() => {
    postJson.mockReset();
    deleteRemoteItem.mockReset();
  });

  it("finalizes cancelled prune runs without reusing the aborted signal", async () => {
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

  it("still finalizes failed prune runs as failed", async () => {
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
    const finalizeCall = postJson.mock.calls.find((call) => String(call[1]).endsWith("/complete"));
    expect(finalizeCall?.[3]).toMatchObject({
      status: "failed",
    });

    const complete = events.find((event) => event.type === "complete");
    expect(complete).toMatchObject({
      summary: {
        action: "prune",
        status: "failed",
      },
    });
  });
});
