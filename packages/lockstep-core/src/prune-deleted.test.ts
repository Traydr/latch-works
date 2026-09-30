import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { pruneDeleted } from "./prune-deleted.js";
import {
  type PruneRemoteApi,
  type SyncRequestBody,
  UnfinalizedSyncRunError,
} from "./remote-api.js";
import type { LockstepPlan, LockstepRunEvent } from "./types.js";

type DeleteRemoteItemRequest = Parameters<PruneRemoteApi["deleteRemoteItem"]>[0];

interface RecordedPostJson {
  apiToken: string;
  apiUrl: string;
  body: SyncRequestBody;
  route: string;
  signal: AbortSignal | undefined;
}

interface RemoteApiFake {
  deleteCalls: DeleteRemoteItemRequest[];
  postJsonCalls: RecordedPostJson[];
  remote: PruneRemoteApi;
}

interface RemoteApiFakeBehaviour {
  onFinalize?: () => Promise<void>;
  onCreateRun?: () => Promise<void>;
  onDelete?: (request: DeleteRemoteItemRequest) => Promise<void>;
}

function createRemoteApiFake(behaviour: RemoteApiFakeBehaviour = {}): RemoteApiFake {
  const deleteCalls: DeleteRemoteItemRequest[] = [];
  const postJsonCalls: RecordedPostJson[] = [];

  const remote: PruneRemoteApi = {
    deleteRemoteItem: async (request) => {
      deleteCalls.push(request);
      await behaviour.onDelete?.(request);
    },
    postJson: async <TSchema extends z.ZodType>(
      apiUrl: string,
      route: string,
      apiToken: string,
      body: SyncRequestBody,
      schema: TSchema,
      signal?: AbortSignal,
    ) => {
      postJsonCalls.push({ apiToken, apiUrl, body, route, signal });

      if (route.endsWith("/complete")) {
        await behaviour.onFinalize?.();
      }

      if (route === "/api/sync/runs") {
        await behaviour.onCreateRun?.();
      }

      return schema.parse(
        route === "/api/sync/runs" ? { syncRunId: "run-1" } : { status: "database" },
      );
    },
  };

  return { deleteCalls, postJsonCalls, remote };
}

function findFinalizeCall(calls: readonly RecordedPostJson[]): RecordedPostJson | undefined {
  return calls.find((call) => call.route.endsWith("/complete"));
}

function createPlan(items: LockstepPlan["items"], sourceRoot: string): LockstepPlan {
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

async function writeSourceFile(sourceRoot: string, archivePath: string): Promise<void> {
  const filePath = path.join(sourceRoot, ...archivePath.split("/"));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "local bytes");
}

describe("pruneDeleted orchestration", () => {
  let fake: RemoteApiFake;
  let sourceRoot: string;

  beforeEach(async () => {
    fake = createRemoteApiFake();
    sourceRoot = await mkdtemp(path.join(os.tmpdir(), "lockstep-prune-"));
  });

  afterEach(async () => {
    await rm(sourceRoot, { force: true, recursive: true });
  });

  it("emits complete without creating a sync run when nothing to prune", async () => {
    const plan = createPlan([{ action: "keep", path: "photos/existing.jpg" }], sourceRoot);
    const { events, observer } = collectEvents();

    const result = await pruneDeleted(
      {
        apiToken: "token",
        apiUrl: "http://127.0.0.1:3000",
        plan,
      },
      observer,
      fake.remote,
    );

    expect(result).toEqual({ failed: 0, plan, pruned: 0, skipped: 0 });
    expect(fake.postJsonCalls).toHaveLength(0);
    expect(fake.deleteCalls).toHaveLength(0);

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
    const plan = createPlan([{ action: "delete", path: "photos/old.jpg" }], sourceRoot);
    const { events, observer } = collectEvents();

    const result = await pruneDeleted(
      {
        apiToken: "token",
        apiUrl: "http://127.0.0.1:3000",
        plan,
      },
      observer,
      fake.remote,
    );

    expect(result).toEqual({ failed: 0, plan, pruned: 1, skipped: 0 });
    expect(fake.postJsonCalls).toHaveLength(2);
    expect(fake.deleteCalls).toMatchObject([
      {
        logicalPath: "photos/old.jpg",
        syncRunId: "run-1",
      },
    ]);

    expect(findFinalizeCall(fake.postJsonCalls)?.body).toMatchObject({
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
    fake = createRemoteApiFake({
      onDelete: async () => {
        throw new Error("delete failed");
      },
    });
    const plan = createPlan([{ action: "delete", path: "photos/old.jpg" }], sourceRoot);
    const { events, observer } = collectEvents();

    const result = await pruneDeleted(
      {
        apiToken: "token",
        apiUrl: "http://127.0.0.1:3000",
        plan,
      },
      observer,
      fake.remote,
    );

    expect(result.failed).toBe(1);
    expect(result.pruned).toBe(0);

    expect(findFinalizeCall(fake.postJsonCalls)?.body).toMatchObject({
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
    fake = createRemoteApiFake({
      onDelete: async ({ signal }) => {
        controller.abort();
        throw signal?.reason ?? new DOMException("Aborted", "AbortError");
      },
    });
    const plan = createPlan([{ action: "delete", path: "photos/old.jpg" }], sourceRoot);
    const { events, observer } = collectEvents();

    await expect(
      pruneDeleted(
        {
          apiToken: "token",
          apiUrl: "http://127.0.0.1:3000",
          plan,
          signal: controller.signal,
        },
        observer,
        fake.remote,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    const finalizeCall = findFinalizeCall(fake.postJsonCalls);
    expect(finalizeCall).toBeDefined();
    expect(finalizeCall?.signal).toBeUndefined();
    expect(finalizeCall?.body).toMatchObject({
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

    const { events, observer } = collectEvents();

    const result = await pruneDeleted(
      { apiToken: "token", apiUrl: "http://127.0.0.1:3000", plan },
      observer,
      fake.remote,
    );

    expect(fake.deleteCalls.map((call) => call.logicalPath)).toEqual([
      "photos/gone-1.jpg",
      "photos/gone-2.jpg",
    ]);
    expect(result).toEqual({ failed: 0, plan, pruned: 2, skipped: 1 });
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
    expect(events.find((event) => event.type === "complete")).toMatchObject({
      summary: { action: "prune", failed: 0, pushed: 2, skipped: 1, status: "completed" },
    });
  });

  it("applies only the first max-changes deletes of the reviewed plan", async () => {
    const plan = createPlan(
      [
        { action: "delete", path: "a.jpg" },
        { action: "delete", path: "b.jpg" },
        { action: "delete", path: "c.jpg" },
      ],
      sourceRoot,
    );

    const result = await pruneDeleted(
      { apiToken: "token", apiUrl: "http://127.0.0.1:3000", maxChanges: 2, plan },
      undefined,
      fake.remote,
    );

    expect(fake.deleteCalls.map((call) => call.logicalPath)).toEqual(["a.jpg", "b.jpg"]);
    expect(result.pruned).toBe(2);
  });

  it("refuses to prune when the source folder is missing", async () => {
    const plan = createPlan(
      [{ action: "delete", path: "a.jpg" }],
      path.join(sourceRoot, "unmounted-drive"),
    );

    await expect(
      pruneDeleted(
        { apiToken: "token", apiUrl: "http://127.0.0.1:3000", plan },
        undefined,
        fake.remote,
      ),
    ).rejects.toThrow(/Source folder is not available/);
    expect(fake.postJsonCalls).toHaveLength(0);
    expect(fake.deleteCalls).toHaveLength(0);
  });

  it("skips a delete whose file came back under an equivalent name", async () => {
    await writeSourceFile(sourceRoot, "photos/restored.jpeg");
    await writeSourceFile(sourceRoot, "Photos/Recased.JPG");

    const plan = createPlan(
      [
        { action: "delete", path: "photos/restored.jpg" },
        { action: "delete", path: "photos/recased.jpg" },
        { action: "delete", path: "photos/gone.jpg" },
      ],
      sourceRoot,
    );

    const result = await pruneDeleted(
      { apiToken: "token", apiUrl: "http://127.0.0.1:3000", plan },
      undefined,
      fake.remote,
    );

    expect(fake.deleteCalls.map((call) => call.logicalPath)).toEqual(["photos/gone.jpg"]);
    expect(result).toMatchObject({ failed: 0, pruned: 1, skipped: 2 });
  });

  it("skips a delete whose alias was restored after its folder was already checked", async () => {
    // Pretend the folder last changed long ago so its listing is reused between deletes.
    vi.useFakeTimers({ now: Date.now() + 60_000, toFake: ["Date"] });
    await writeSourceFile(sourceRoot, "photos/kept.jpg");
    fake = createRemoteApiFake({
      onDelete: async ({ logicalPath }) => {
        if (logicalPath === "photos/first.jpg") {
          await writeSourceFile(sourceRoot, "photos/second.jpeg");
        }
      },
    });

    const plan = createPlan(
      [
        { action: "keep", path: "photos/kept.jpg" },
        { action: "delete", path: "photos/first.jpg" },
        { action: "delete", path: "photos/second.jpg" },
      ],
      sourceRoot,
    );

    try {
      const result = await pruneDeleted(
        { apiToken: "token", apiUrl: "http://127.0.0.1:3000", plan },
        undefined,
        fake.remote,
      );

      expect(fake.deleteCalls.map((call) => call.logicalPath)).toEqual(["photos/first.jpg"]);
      expect(result).toMatchObject({ failed: 0, pruned: 1, skipped: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("still deletes a jpeg twin when its jpg sibling was already in the plan", async () => {
    await writeSourceFile(sourceRoot, "photos/photo.jpg");

    const plan = createPlan(
      [
        { action: "keep", path: "photos/photo.jpg" },
        { action: "delete", path: "photos/photo.jpeg" },
      ],
      sourceRoot,
    );

    const result = await pruneDeleted(
      { apiToken: "token", apiUrl: "http://127.0.0.1:3000", plan },
      undefined,
      fake.remote,
    );

    expect(fake.deleteCalls.map((call) => call.logicalPath)).toEqual(["photos/photo.jpeg"]);
    expect(result).toMatchObject({ failed: 0, pruned: 1, skipped: 0 });
  });

  it("stops without deleting when the source folder disappears mid-run", async () => {
    await writeSourceFile(sourceRoot, "photos/back.jpg");
    fake = createRemoteApiFake({
      onCreateRun: () => rename(sourceRoot, `${sourceRoot}-moved`),
    });
    const plan = createPlan([{ action: "delete", path: "photos/back.jpg" }], sourceRoot);

    try {
      await expect(
        pruneDeleted(
          { apiToken: "token", apiUrl: "http://127.0.0.1:3000", plan },
          undefined,
          fake.remote,
        ),
      ).rejects.toThrow(/Source folder is not available/);
    } finally {
      await rm(`${sourceRoot}-moved`, { force: true, recursive: true });
    }

    expect(fake.deleteCalls).toHaveLength(0);
    expect(findFinalizeCall(fake.postJsonCalls)?.body).toMatchObject({ status: "failed" });
  });

  it("stops without deleting when the source folder is replaced by an empty one", async () => {
    await writeSourceFile(sourceRoot, "photos/back.jpg");
    fake = createRemoteApiFake({
      onCreateRun: async () => {
        await rename(sourceRoot, `${sourceRoot}-moved`);
        await mkdir(sourceRoot);
      },
    });
    const plan = createPlan([{ action: "delete", path: "photos/back.jpg" }], sourceRoot);

    try {
      await expect(
        pruneDeleted(
          { apiToken: "token", apiUrl: "http://127.0.0.1:3000", plan },
          undefined,
          fake.remote,
        ),
      ).rejects.toThrow(/Source folder is not available/);
    } finally {
      await rm(`${sourceRoot}-moved`, { force: true, recursive: true });
    }

    expect(fake.deleteCalls).toHaveLength(0);
  });

  it("fails the prune when the sync run cannot be finalized", async () => {
    fake = createRemoteApiFake({
      onFinalize: async () => {
        throw new Error("simulated HTTP 503");
      },
    });
    const plan = createPlan([{ action: "delete", path: "photos/old.jpg" }], sourceRoot);
    const { events, observer } = collectEvents();

    await expect(
      pruneDeleted(
        { apiToken: "token", apiUrl: "http://127.0.0.1:3000", plan },
        observer,
        fake.remote,
      ),
    ).rejects.toThrow(/sync run run-1 could not be finalized/);

    expect(fake.deleteCalls).toHaveLength(1);
    expect(events.find((event) => event.type === "complete")).toMatchObject({
      summary: { action: "prune", failed: 0, pushed: 1, status: "failed" },
    });
  });

  it("names the unfinalized run when a cancelled prune cannot be finalized", async () => {
    const controller = new AbortController();
    const reason = new DOMException("user cancelled", "AbortError");
    fake = createRemoteApiFake({
      onDelete: async () => {
        controller.abort(reason);
        throw reason;
      },
      onFinalize: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const plan = createPlan([{ action: "delete", path: "photos/old.jpg" }], sourceRoot);
    const { events, observer } = collectEvents();

    const error = await pruneDeleted(
      { apiToken: "token", apiUrl: "http://127.0.0.1:3000", plan, signal: controller.signal },
      observer,
      fake.remote,
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(UnfinalizedSyncRunError);
    expect(error).toMatchObject({
      action: "prune",
      cause: reason,
      intendedStatus: "cancelled",
      message: expect.stringMatching(/cancelled.*sync run run-1 could not be finalized/),
      syncRunId: "run-1",
    });
    expect(events.filter((event) => event.type === "complete")).toEqual([
      expect.objectContaining({
        summary: expect.objectContaining({
          message: expect.stringContaining("run-1"),
          status: "failed",
        }),
      }),
    ]);
  });

  it("names the unfinalized run when the source folder goes away and finalizing fails", async () => {
    await writeSourceFile(sourceRoot, "photos/back.jpg");
    fake = createRemoteApiFake({
      onCreateRun: () => rename(sourceRoot, `${sourceRoot}-moved`),
      onFinalize: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const plan = createPlan([{ action: "delete", path: "photos/back.jpg" }], sourceRoot);
    const { events, observer } = collectEvents();

    let error: unknown;

    try {
      error = await pruneDeleted(
        { apiToken: "token", apiUrl: "http://127.0.0.1:3000", plan },
        observer,
        fake.remote,
      ).catch((cause: unknown) => cause);
    } finally {
      await rm(`${sourceRoot}-moved`, { force: true, recursive: true });
    }

    expect(fake.deleteCalls).toHaveLength(0);
    expect(error).toBeInstanceOf(UnfinalizedSyncRunError);
    expect(error).toMatchObject({
      cause: { name: "SourceRootUnavailableError" },
      intendedStatus: "failed",
      message: expect.stringMatching(/Source folder is not available.*sync run run-1/),
      syncRunId: "run-1",
    });
    expect(events.find((event) => event.type === "complete")).toMatchObject({
      summary: { action: "prune", status: "failed" },
    });
  });
});
