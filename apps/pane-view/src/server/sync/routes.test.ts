import { beforeEach, describe, expect, it, vi } from "vitest";

import { postCompleteObject } from "../../routes/api.sync.complete-object";
import { postSyncRuns } from "../../routes/api.sync.runs";
import { postSyncRunComplete } from "../../routes/api.sync.runs.$syncRunId.complete";
import { postUploadUrl } from "../../routes/api.sync.upload-url";
import type { SyncRouteDependencies } from "./route-dependencies";

const assertNoActiveCleanupJob = vi.fn(async () => undefined);
const completeSyncedObject = vi.fn();
const createSignedUploadUrl = vi.fn();
const finalizeSyncRun = vi.fn();
const markRemoteDeleted = vi.fn();
const requireSyncApiToken = vi.fn();
const startSyncRun = vi.fn();

/** The handlers are what is under test: the token check, the store, and the bucket stand in. */
const dependencies: SyncRouteDependencies = {
  assertNoActiveCleanupJob,
  completeSyncedObject,
  createSignedUploadUrl,
  finalizeSyncRun,
  markRemoteDeleted,
  requireSyncApiToken,
  startSyncRun,
};

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

describe("sync route handlers", () => {
  beforeEach(() => {
    requireSyncApiToken.mockReset();
    startSyncRun.mockReset();
    finalizeSyncRun.mockReset();
    completeSyncedObject.mockReset();
    markRemoteDeleted.mockReset();
    createSignedUploadUrl.mockReset();

    requireSyncApiToken.mockReturnValue(null);
    startSyncRun.mockResolvedValue({ syncRunId: "run-1" });
    finalizeSyncRun.mockResolvedValue({ status: "database" });
    completeSyncedObject.mockResolvedValue({ status: "database" });
    markRemoteDeleted.mockResolvedValue({ status: "database" });
    createSignedUploadUrl.mockResolvedValue({
      headers: { "Content-Type": "image/jpeg" },
      uploadUrl: "https://storage.example/upload",
    });
  });

  describe("POST /api/sync/runs", () => {
    it("passes counts and sourceRoot through to startSyncRun", async () => {
      const counts = { delete: 0, keep: 1, update: 0, upload: 2 };
      const request = new Request("http://127.0.0.1:3000/api/sync/runs", {
        body: JSON.stringify({ counts, sourceRoot: "/tmp/archive" }),
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        method: "POST",
      });

      const response = await postSyncRuns({ request }, dependencies);
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

      const response = await postSyncRuns({ request }, dependencies);

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

      const response = await postSyncRunComplete(
        {
          params: { syncRunId: "run-1" },
          request,
        },
        dependencies,
      );
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

      const response = await postSyncRunComplete(
        {
          params: { syncRunId: "run-1" },
          request,
        },
        dependencies,
      );

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

      const response = await postCompleteObject({ request }, dependencies);
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

      const response = await postCompleteObject({ request }, dependencies);
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

    it("propagates store rejection from upload completion", async () => {
      completeSyncedObject.mockRejectedValue(new Error("Sync run is not accepting writes."));

      const request = new Request("http://127.0.0.1:3000/api/sync/complete-object", {
        body: JSON.stringify(validUploadPayload),
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        method: "POST",
      });

      await expect(postCompleteObject({ request }, dependencies)).rejects.toThrow(
        "Sync run is not accepting writes.",
      );
    });

    it("returns the auth response without calling stores when unauthorized", async () => {
      const unauthorized = new Response("Unauthorized", { status: 401 });
      requireSyncApiToken.mockReturnValue(unauthorized);

      const request = new Request("http://127.0.0.1:3000/api/sync/complete-object", {
        body: JSON.stringify(validUploadPayload),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      const response = await postCompleteObject({ request }, dependencies);

      expect(response).toBe(unauthorized);
      expect(completeSyncedObject).not.toHaveBeenCalled();
      expect(markRemoteDeleted).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/sync/upload-url", () => {
    it("signs upload URLs with declared size and returns required headers", async () => {
      createSignedUploadUrl.mockResolvedValue({
        headers: {
          "Content-Length": "128",
          "Content-Type": "image/jpeg",
          "x-amz-checksum-sha256": "checksum",
          "x-amz-meta-sha256": "a".repeat(64),
        },
        uploadUrl: "https://storage.example/upload",
      });

      const request = new Request("http://127.0.0.1:3000/api/sync/upload-url", {
        body: JSON.stringify({
          contentType: "image/jpeg",
          filename: "cover.jpg",
          sha256: "a".repeat(64),
          size: 128,
        }),
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        method: "POST",
      });

      const response = await postUploadUrl({ request }, dependencies);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(createSignedUploadUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          contentLength: 128,
          contentType: "image/jpeg",
          sha256: "a".repeat(64),
        }),
      );
      expect(body).toEqual({
        headers: expect.objectContaining({
          "Content-Type": "image/jpeg",
        }),
        maxUploadBytes: expect.any(Number),
        objectKey: expect.any(String),
        status: "signed-url-ready",
        uploadUrl: "https://storage.example/upload",
      });
    });

    it("rejects missing size with 400", async () => {
      const request = new Request("http://127.0.0.1:3000/api/sync/upload-url", {
        body: JSON.stringify({
          contentType: "image/jpeg",
          filename: "cover.jpg",
          sha256: "a".repeat(64),
        }),
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        method: "POST",
      });

      const response = await postUploadUrl({ request }, dependencies);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toEqual({ error: "size is required" });
      expect(createSignedUploadUrl).not.toHaveBeenCalled();
    });

    it("rejects mismatched content types with 400", async () => {
      const request = new Request("http://127.0.0.1:3000/api/sync/upload-url", {
        body: JSON.stringify({
          contentType: "image/png",
          filename: "cover.jpg",
          sha256: "a".repeat(64),
          size: 128,
        }),
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        method: "POST",
      });

      const response = await postUploadUrl({ request }, dependencies);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toEqual({ error: "contentType does not match extension" });
      expect(createSignedUploadUrl).not.toHaveBeenCalled();
    });
  });
});
