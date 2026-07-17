import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncRuns } from "../db/schema";

function createInsertChain(resolvedValue: unknown) {
  const returningMock = vi.fn().mockResolvedValue(resolvedValue);
  const onConflictDoUpdateMock = vi.fn().mockReturnValue({ returning: returningMock });
  const valuesMock = vi.fn().mockReturnValue({ onConflictDoUpdate: onConflictDoUpdateMock });
  const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
  return { insertMock, onConflictDoUpdateMock, returningMock, valuesMock };
}

function createSelectChain(resolvedValue: unknown) {
  const limitMock = vi.fn().mockResolvedValue(resolvedValue);
  const whereMock = vi.fn().mockReturnValue({ limit: limitMock });
  const fromMock = vi.fn().mockReturnValue({ where: whereMock });
  const selectMock = vi.fn().mockReturnValue({ from: fromMock });
  return { fromMock, limitMock, selectMock, whereMock };
}

function createUpdateChain() {
  const whereMock = vi.fn().mockResolvedValue(undefined);
  const setMock = vi.fn().mockReturnValue({ where: whereMock });
  const updateMock = vi.fn().mockReturnValue({ set: setMock });
  return { setMock, updateMock, whereMock };
}

const mocks = vi.hoisted(() => {
  const updateMock = vi.fn();
  const whereMock = vi.fn();
  const setMock = vi.fn();
  const returningMock = vi.fn();
  const transactionMock = vi.fn();
  const rootInsertMock = vi.fn();
  const rootSelectMock = vi.fn();
  const headStoredObject = vi.fn();
  const txClient = {
    insert: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
  };

  return {
    headStoredObject,
    returningMock,
    rootInsertMock,
    rootSelectMock,
    setMock,
    transactionMock,
    txClient,
    updateMock,
    whereMock,
  };
});

vi.mock("../db", () => ({
  db: {
    insert: mocks.rootInsertMock,
    select: mocks.rootSelectMock,
    transaction: mocks.transactionMock,
    update: mocks.updateMock,
  },
}));

vi.mock("../../env/server", () => ({
  env: {
    S3_ACCESS_KEY_ID: "test-access-key",
    S3_BUCKET: "test-bucket",
    S3_ENDPOINT: "http://127.0.0.1:9000",
    S3_REGION: "us-east-1",
    S3_SECRET_ACCESS_KEY: "test-secret-key",
  },
}));

vi.mock("@latch-works/media-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@latch-works/media-storage")>();
  return {
    ...actual,
    createS3StorageClient: vi.fn(() => ({ bucket: "test-bucket", client: {} })),
    headStoredObject: mocks.headStoredObject,
  };
});

vi.mock("../management/guards", () => ({
  assertNoActiveCleanupJob: vi.fn(async () => undefined),
}));

vi.mock("../db/library-coordination-lock", () => ({
  acquireLibraryMutationStartupLock: vi.fn(async () => undefined),
}));

import { completeSyncedObject, finalizeSyncRun, markRemoteDeleted } from "./store";

describe("finalizeSyncRun", () => {
  beforeEach(() => {
    mocks.updateMock.mockReset();
    mocks.whereMock.mockReset();
    mocks.setMock.mockReset();
    mocks.returningMock.mockReset();
    mocks.rootSelectMock.mockReset();

    mocks.updateMock.mockReturnValue({ set: mocks.setMock });
    mocks.setMock.mockReturnValue({ where: mocks.whereMock });
    mocks.whereMock.mockReturnValue({ returning: mocks.returningMock });
  });

  it("marks completed runs with final counts", async () => {
    mocks.returningMock.mockResolvedValue([{ id: "run-1" }]);

    const result = await finalizeSyncRun({
      input: {
        counts: { pushed: 2, planned: 2 },
        status: "completed",
        syncRunId: "run-1",
      },
    });

    expect(result).toEqual({ status: "database" });
    expect(mocks.setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        counts: { pushed: 2, planned: 2 },
        error: null,
        status: "completed",
      }),
    );
    expect(mocks.whereMock).toHaveBeenCalledWith(
      and(eq(syncRuns.id, "run-1"), eq(syncRuns.status, "running")),
    );
  });

  it("marks cancelled runs with error text", async () => {
    mocks.returningMock.mockResolvedValue([{ id: "run-1" }]);

    await finalizeSyncRun({
      input: {
        counts: { failed: 0, planned: 2, pushed: 1 },
        error: "Run cancelled by user",
        status: "cancelled",
        syncRunId: "run-1",
      },
    });

    expect(mocks.setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        counts: { failed: 0, planned: 2, pushed: 1 },
        error: "Run cancelled by user",
        status: "cancelled",
      }),
    );
  });

  it("marks failed runs with error text", async () => {
    mocks.returningMock.mockResolvedValue([{ id: "run-1" }]);

    await finalizeSyncRun({
      input: {
        counts: { failed: 1, pushed: 0, planned: 1 },
        error: "1 item(s) failed during push",
        status: "failed",
        syncRunId: "run-1",
      },
    });

    expect(mocks.setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "1 item(s) failed during push",
        status: "failed",
      }),
    );
  });

  it("accepts an exact terminal-status replay without updating details", async () => {
    mocks.returningMock.mockResolvedValue([]);
    const select = createSelectChain([{ status: "completed" }]);
    mocks.rootSelectMock.mockReturnValue({ from: select.fromMock });

    const result = await finalizeSyncRun({
      input: {
        counts: { planned: 2, pushed: 2 },
        status: "completed",
        syncRunId: "run-1",
      },
    });

    expect(result).toEqual({ status: "database" });
    expect(select.whereMock).toHaveBeenCalledWith(eq(syncRuns.id, "run-1"));
  });

  it("rejects a cancelled run finalized as completed", async () => {
    mocks.returningMock.mockResolvedValue([]);
    const select = createSelectChain([{ status: "cancelled" }]);
    mocks.rootSelectMock.mockReturnValue({ from: select.fromMock });

    await expect(
      finalizeSyncRun({
        input: {
          counts: { planned: 2, pushed: 2 },
          status: "completed",
          syncRunId: "run-1",
        },
      }),
    ).rejects.toThrow("Unable to finalize sync run.");

    expect(select.whereMock).toHaveBeenCalledWith(eq(syncRuns.id, "run-1"));
  });

  it("rejects a completed run finalized as failed", async () => {
    mocks.returningMock.mockResolvedValue([]);
    const select = createSelectChain([{ status: "completed" }]);
    mocks.rootSelectMock.mockReturnValue({ from: select.fromMock });

    await expect(
      finalizeSyncRun({
        input: {
          error: "1 item(s) failed during push",
          status: "failed",
          syncRunId: "run-1",
        },
      }),
    ).rejects.toThrow("Unable to finalize sync run.");

    expect(select.whereMock).toHaveBeenCalledWith(eq(syncRuns.id, "run-1"));
  });
});

describe("completeSyncedObject", () => {
  beforeEach(() => {
    mocks.transactionMock.mockReset();
    mocks.rootInsertMock.mockReset();
    mocks.txClient.insert.mockReset();
    mocks.txClient.select.mockReset();
    mocks.txClient.update.mockReset();
    mocks.headStoredObject.mockReset();

    mocks.transactionMock.mockImplementation(async (callback) => callback(mocks.txClient));
    mocks.headStoredObject.mockResolvedValue({
      checksumSHA256: Buffer.from("abc123".padEnd(64, "0"), "hex").toString("base64"),
      contentLength: 1024,
      contentType: "image/jpeg",
      etag: '"etag"',
      metadata: { sha256: "abc123".padEnd(64, "0") },
    });
  });

  it("performs all writes inside a transaction client after HEAD attestation", async () => {
    const syncRunSelect = createSelectChain([{ id: "run-1", status: "running" }]);
    const mediaInsert = createInsertChain([{ id: "media-1" }]);
    const folderInsert = createInsertChain([{ id: "folder-1" }]);
    const libraryInsert = createInsertChain(undefined);
    const syncItemInsert = createInsertChain(undefined);

    mocks.txClient.select.mockReturnValue({ from: syncRunSelect.fromMock });
    mocks.txClient.insert
      .mockReturnValueOnce({ values: mediaInsert.valuesMock })
      .mockReturnValueOnce({ values: folderInsert.valuesMock })
      .mockReturnValueOnce({ values: libraryInsert.valuesMock })
      .mockReturnValueOnce({ values: syncItemInsert.valuesMock });

    const sha256 = "abc123".padEnd(64, "0");
    const result = await completeSyncedObject({
      input: {
        contentType: "image/jpeg",
        extension: "jpg",
        filename: "photo.jpg",
        logicalPath: "photos/photo.jpg",
        mediaType: "image",
        mtimeMs: 1_700_000_000_000,
        objectKey: "objects/abc",
        sha256,
        size: 1024,
        syncRunId: "run-1",
      },
    });

    expect(result).toEqual({ status: "database" });
    expect(mocks.headStoredObject).toHaveBeenCalledWith(
      expect.objectContaining({ key: "objects/abc" }),
    );
    expect(mocks.transactionMock).toHaveBeenCalledTimes(1);
    expect(mocks.rootInsertMock).not.toHaveBeenCalled();
    expect(mocks.txClient.insert).toHaveBeenCalledTimes(4);
    expect(mocks.txClient.select.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.txClient.insert.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(syncItemInsert.valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "upload",
        logicalPath: "photos/photo.jpg",
        mediaObjectId: "media-1",
        syncRunId: "run-1",
      }),
    );
  });

  it("rejects missing storage objects before opening a transaction", async () => {
    mocks.headStoredObject.mockResolvedValue(null);

    await expect(
      completeSyncedObject({
        input: {
          contentType: "image/jpeg",
          extension: "jpg",
          filename: "photo.jpg",
          logicalPath: "photos/photo.jpg",
          mediaType: "image",
          mtimeMs: 1_700_000_000_000,
          objectKey: "objects/abc",
          sha256: "abc123".padEnd(64, "0"),
          size: 1024,
          syncRunId: "run-1",
        },
      }),
    ).rejects.toThrow("Uploaded object was not found in storage.");

    expect(mocks.transactionMock).not.toHaveBeenCalled();
  });

  it("rejects size mismatches before opening a transaction", async () => {
    mocks.headStoredObject.mockResolvedValue({
      checksumSHA256: undefined,
      contentLength: 10,
      contentType: "image/jpeg",
      etag: '"etag"',
      metadata: undefined,
    });

    await expect(
      completeSyncedObject({
        input: {
          contentType: "image/jpeg",
          extension: "jpg",
          filename: "photo.jpg",
          logicalPath: "photos/photo.jpg",
          mediaType: "image",
          mtimeMs: 1_700_000_000_000,
          objectKey: "objects/abc",
          sha256: "abc123".padEnd(64, "0"),
          size: 1024,
          syncRunId: "run-1",
        },
      }),
    ).rejects.toThrow("Uploaded object size does not match declared size.");

    expect(mocks.transactionMock).not.toHaveBeenCalled();
  });

  it("rejects non-running sync runs without mutating media objects", async () => {
    const syncRunSelect = createSelectChain([{ id: "run-1", status: "completed" }]);
    const mediaInsert = createInsertChain([{ id: "media-1" }]);

    mocks.txClient.select.mockReturnValue({ from: syncRunSelect.fromMock });
    mocks.txClient.insert.mockReturnValue({ values: mediaInsert.valuesMock });

    await expect(
      completeSyncedObject({
        input: {
          contentType: "image/jpeg",
          extension: "jpg",
          filename: "photo.jpg",
          logicalPath: "photos/photo.jpg",
          mediaType: "image",
          mtimeMs: 1_700_000_000_000,
          objectKey: "objects/abc",
          sha256: "abc123".padEnd(64, "0"),
          size: 1024,
          syncRunId: "run-1",
        },
      }),
    ).rejects.toThrow("Sync run is not accepting writes.");

    expect(mediaInsert.valuesMock).not.toHaveBeenCalled();
    expect(mocks.txClient.insert).not.toHaveBeenCalled();
  });
});

describe("markRemoteDeleted", () => {
  beforeEach(() => {
    mocks.transactionMock.mockReset();
    mocks.txClient.insert.mockReset();
    mocks.txClient.select.mockReset();
    mocks.txClient.update.mockReset();

    mocks.transactionMock.mockImplementation(async (callback) => callback(mocks.txClient));
  });

  it("validates the sync run before updating library entries", async () => {
    const syncRunSelect = createSelectChain([{ id: "run-1", status: "running" }]);
    const libraryUpdate = createUpdateChain();
    const syncItemInsert = createInsertChain(undefined);

    mocks.txClient.select.mockReturnValue({ from: syncRunSelect.fromMock });
    mocks.txClient.update.mockReturnValue({ set: libraryUpdate.setMock });
    mocks.txClient.insert.mockReturnValue({ values: syncItemInsert.valuesMock });

    const result = await markRemoteDeleted({
      logicalPath: "photos/photo.jpg",
      syncRunId: "run-1",
    });

    expect(result).toEqual({ status: "database" });
    expect(mocks.transactionMock).toHaveBeenCalledTimes(1);
    expect(mocks.txClient.select.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.txClient.update.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(libraryUpdate.setMock).toHaveBeenCalledWith({ deletedAt: expect.any(Date) });
    expect(syncItemInsert.valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "delete",
        logicalPath: "photos/photo.jpg",
        syncRunId: "run-1",
      }),
    );
  });

  it("rejects missing sync runs without mutating library entries", async () => {
    const syncRunSelect = createSelectChain([]);
    const libraryUpdate = createUpdateChain();

    mocks.txClient.select.mockReturnValue({ from: syncRunSelect.fromMock });
    mocks.txClient.update.mockReturnValue({ set: libraryUpdate.setMock });

    await expect(
      markRemoteDeleted({
        logicalPath: "photos/photo.jpg",
        syncRunId: "missing-run",
      }),
    ).rejects.toThrow("Sync run not found.");

    expect(libraryUpdate.setMock).not.toHaveBeenCalled();
    expect(mocks.txClient.insert).not.toHaveBeenCalled();
  });

  it("rejects non-running sync runs without mutating library entries", async () => {
    const syncRunSelect = createSelectChain([{ id: "run-1", status: "completed" }]);
    const libraryUpdate = createUpdateChain();

    mocks.txClient.select.mockReturnValue({ from: syncRunSelect.fromMock });
    mocks.txClient.update.mockReturnValue({ set: libraryUpdate.setMock });

    await expect(
      markRemoteDeleted({
        logicalPath: "photos/photo.jpg",
        syncRunId: "run-1",
      }),
    ).rejects.toThrow("Sync run is not accepting writes.");

    expect(libraryUpdate.setMock).not.toHaveBeenCalled();
    expect(mocks.txClient.insert).not.toHaveBeenCalled();
  });
});
