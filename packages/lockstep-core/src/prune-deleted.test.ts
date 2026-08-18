import { beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { pruneDeleted } from "./prune-deleted.js";
import type { PruneRemoteApi, SyncRequestBody } from "./remote-api.js";
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
  let fake: RemoteApiFake;

  beforeEach(() => {
    fake = createRemoteApiFake();
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
      fake.remote,
    );

    expect(result).toEqual({ failed: 0, plan, pruned: 0 });
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
    const plan = createPlan([{ action: "delete", path: "photos/old.jpg" }]);
    const { events, observer } = collectEvents();

    const result = await pruneDeleted(
      {
        apiToken: "token",
        apiUrl: "http://127.0.0.1:3000",
        plan,
        sourceRoot: plan.sourceRoot,
      },
      observer,
      fake.remote,
    );

    expect(result).toEqual({ failed: 0, plan, pruned: 1 });
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
    const plan = createPlan([{ action: "delete", path: "photos/old.jpg" }]);
    const { events, observer } = collectEvents();

    const result = await pruneDeleted(
      {
        apiToken: "token",
        apiUrl: "http://127.0.0.1:3000",
        plan,
        sourceRoot: plan.sourceRoot,
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
    const plan = createPlan([{ action: "delete", path: "photos/old.jpg" }]);
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
});
