import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  completeSyncedObject: vi.fn(),
  finalizeSyncRun: vi.fn(),
  markRemoteDeleted: vi.fn(),
  requireSyncApiToken: vi.fn(),
  startSyncRun: vi.fn(),
}));

vi.mock("../auth/api-token", () => ({
  requireSyncApiToken: mocks.requireSyncApiToken,
}));

vi.mock("./store", () => ({
  completeSyncedObject: mocks.completeSyncedObject,
  finalizeSyncRun: mocks.finalizeSyncRun,
  markRemoteDeleted: mocks.markRemoteDeleted,
  startSyncRun: mocks.startSyncRun,
}));

import { Route as CompleteObjectRoute } from "../../routes/api.sync.complete-object";
import { Route as SyncRunsRoute } from "../../routes/api.sync.runs";
import { Route as SyncRunCompleteRoute } from "../../routes/api.sync.runs.$syncRunId.complete";

const {
  completeSyncedObject,
  finalizeSyncRun,
  markRemoteDeleted,
  requireSyncApiToken,
  startSyncRun,
} = mocks;

const validUploadPayload = {
  contentType: "image/jpeg",
  extension: "jpg",
  filename: "cover.jpg",
  logicalPath: "photos/cover.jpg",
  mediaType: "image",
  mtimeMs: 1_700_000_000_000,
  sha256: "a".repeat(64),
  size: 128,
  syncRunId: "11111111-1111-4111-8111-111111111111",
};

function authHeaders(): HeadersInit {
  return { Authorization: "Bearer test-token" };
}

type SyncRunsPost = (ctx: { request: Request }) => Promise<Response>;
type SyncRunCompletePost = (ctx: {
  params: { syncRunId: string };
  request: Request;
}) => Promise<Response>;

function getPostHandler<T>(handlers: unknown): T {
  return (handlers as { POST: T }).POST;
}

function postSyncRuns(): SyncRunsPost {
  return getPostHandler(SyncRunsRoute.options.server!.handlers);
}

function postSyncRunComplete(): SyncRunCompletePost {
  return getPostHandler(SyncRunCompleteRoute.options.server!.handlers);
}

function postCompleteObject(): SyncRunsPost {
  return getPostHandler(CompleteObjectRoute.options.server!.handlers);
}

describe("sync route handlers", () => {
  beforeEach(() => {
    requireSyncApiToken.mockReset();
    startSyncRun.mockReset();
    finalizeSyncRun.mockReset();
    completeSyncedObject.mockReset();
    markRemoteDeleted.mockReset();

    requireSyncApiToken.mockReturnValue(null);
    startSyncRun.mockResolvedValue({ syncRunId: "run-1" });
    finalizeSyncRun.mockResolvedValue({ status: "database" });
    completeSyncedObject.mockResolvedValue({ status: "database" });
    markRemoteDeleted.mockResolvedValue({ status: "database" });
  });

  describe("POST /api/sync/runs", () => {
    it("passes counts and sourceRoot through to startSyncRun", async () => {
      const counts = { delete: 0, keep: 1, update: 0, upload: 2 };
      const request = new Request("http://127.0.0.1:3000/api/sync/runs", {
        body: JSON.stringify({ counts, sourceRoot: "/tmp/archive" }),
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        method: "POST",
      });

      const response = await postSyncRuns()({ request });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(startSyncRun).toHaveBeenCalledWith({
        input: {
          counts,
          sourceRoot: "/tmp/archive",
        },
      });
      expect(body).toEqual({ syncRunId: "run-1" });
    });

    it("returns the auth response without calling startSyncRun when unauthorized", async () => {
      const unauthorized = new Response("Unauthorized", { status: 401 });
      requireSyncApiToken.mockReturnValue(unauthorized);

      const request = new Request("http://127.0.0.1:3000/api/sync/runs", {
        body: JSON.stringify({ counts: {}, sourceRoot: "/tmp/archive" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      const response = await postSyncRuns()({ request });

      expect(response).toBe(unauthorized);
      expect(startSyncRun).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/sync/runs/$syncRunId/complete", () => {
    it("rejects invalid status with 400", async () => {
      const request = new Request("http://127.0.0.1:3000/api/sync/runs/run-1/complete", {
        body: JSON.stringify({ status: "running" }),
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        method: "POST",
      });

      const response = await postSyncRunComplete()({
        params: { syncRunId: "run-1" },
        request,
      });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toEqual({ error: "status must be completed, failed, or cancelled" });
      expect(finalizeSyncRun).not.toHaveBeenCalled();
    });

    it("returns the auth response without calling finalizeSyncRun when unauthorized", async () => {
      const unauthorized = new Response("Unauthorized", { status: 401 });
      requireSyncApiToken.mockReturnValue(unauthorized);

      const request = new Request("http://127.0.0.1:3000/api/sync/runs/run-1/complete", {
        body: JSON.stringify({ status: "completed" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      const response = await postSyncRunComplete()({
        params: { syncRunId: "run-1" },
        request,
      });

      expect(response).toBe(unauthorized);
      expect(finalizeSyncRun).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/sync/complete-object", () => {
    it("routes delete payloads to markRemoteDeleted", async () => {
      const request = new Request("http://127.0.0.1:3000/api/sync/complete-object", {
        body: JSON.stringify({
          action: "delete",
          logicalPath: "photos/old.jpg",
          syncRunId: "run-1",
        }),
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        method: "POST",
      });

      const response = await postCompleteObject()({ request });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(markRemoteDeleted).toHaveBeenCalledWith({
        logicalPath: "photos/old.jpg",
        syncRunId: "run-1",
      });
      expect(completeSyncedObject).not.toHaveBeenCalled();
      expect(body).toEqual({ status: "database" });
    });

    it("routes valid upload payloads to completeSyncedObject", async () => {
      const request = new Request("http://127.0.0.1:3000/api/sync/complete-object", {
        body: JSON.stringify(validUploadPayload),
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        method: "POST",
      });

      const response = await postCompleteObject()({ request });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(completeSyncedObject).toHaveBeenCalledOnce();
      expect(completeSyncedObject.mock.calls[0]?.[0].input).toMatchObject({
        logicalPath: "photos/cover.jpg",
        syncRunId: validUploadPayload.syncRunId,
      });
      expect(markRemoteDeleted).not.toHaveBeenCalled();
      expect(body).toEqual({ status: "database" });
    });

    it("returns the auth response without calling stores when unauthorized", async () => {
      const unauthorized = new Response("Unauthorized", { status: 401 });
      requireSyncApiToken.mockReturnValue(unauthorized);

      const request = new Request("http://127.0.0.1:3000/api/sync/complete-object", {
        body: JSON.stringify(validUploadPayload),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      const response = await postCompleteObject()({ request });

      expect(response).toBe(unauthorized);
      expect(completeSyncedObject).not.toHaveBeenCalled();
      expect(markRemoteDeleted).not.toHaveBeenCalled();
    });
  });
});
