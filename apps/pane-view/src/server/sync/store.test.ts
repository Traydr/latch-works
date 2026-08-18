import type { S3StorageClient, StoredObjectHead } from "@latch-works/media-storage";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { folders, libraryEntries, mediaObjects, syncRunItems, syncRuns } from "../db/schema";
import { testDatabaseForSuite } from "../library/test-db";
import type { SyncStoreDependencies } from "./store";
import { completeSyncedObject, finalizeSyncRun, markRemoteDeleted } from "./store";

/**
 * The sync writes against executed SQL: the archive is a real database, and
 * only the two things a sync reaches outside it — the cleanup guard and the
 * object storage HEAD attestation — stand in.
 */

const testDatabase = testDatabaseForSuite();

const headStoredObject = vi.fn();

// SAFETY: `headStoredObject` is the only call that receives this client and it
// is faked below, so no S3Client method is ever invoked on it.
const storage = { bucket: "test-bucket", client: {} as S3StorageClient["client"] };

function dependencies(): SyncStoreDependencies {
  return {
    acquireLibraryMutationStartupLock: async () => undefined,
    assertNoActiveCleanupJob: async () => undefined,
    database: testDatabase().db,
    headStoredObject,
  };
}

const sha256 = "abc123".padEnd(64, "0");

const attestedHead: StoredObjectHead = {
  checksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
  contentLength: 1024,
  contentType: "image/jpeg",
  etag: '"etag"',
  metadata: { sha256 },
};

const uploadInput = {
  contentType: "image/jpeg",
  extension: "jpg",
  filename: "photo.jpg",
  logicalPath: "photos/photo.jpg",
  mediaType: "image" as const,
  mtimeMs: 1_700_000_000_000,
  objectKey: "objects/abc",
  sha256,
  size: 1024,
  syncRunId: "",
};

async function insertRun(status: "running" | "completed" | "cancelled"): Promise<string> {
  const [run] = await testDatabase()
    .db.insert(syncRuns)
    .values({ sourceRoot: "/archive", status })
    .returning({ id: syncRuns.id });
  if (!run) throw new Error("failed to insert sync run");
  return run.id;
}

async function readRun(syncRunId: string) {
  const [run] = await testDatabase().db.select().from(syncRuns).where(eq(syncRuns.id, syncRunId));
  if (!run) throw new Error(`sync run ${syncRunId} not found`);
  return run;
}

beforeEach(async () => {
  const { db } = testDatabase();
  await db.delete(syncRunItems);
  await db.delete(libraryEntries);
  await db.delete(mediaObjects);
  await db.delete(folders);
  await db.delete(syncRuns);
  headStoredObject.mockReset();
  headStoredObject.mockResolvedValue(attestedHead);
});

describe("finalizeSyncRun", () => {
  it("marks completed runs with final counts", async () => {
    const syncRunId = await insertRun("running");

    const result = await finalizeSyncRun(
      { input: { counts: { pushed: 2, planned: 2 }, status: "completed", syncRunId } },
      dependencies(),
    );

    expect(result).toEqual({ status: "database" });
    const run = await readRun(syncRunId);
    expect(run.status).toBe("completed");
    expect(run.counts).toEqual({ pushed: 2, planned: 2 });
    expect(run.error).toBeNull();
    expect(run.completedAt).toBeInstanceOf(Date);
  });

  it("marks cancelled runs with error text", async () => {
    const syncRunId = await insertRun("running");

    await finalizeSyncRun(
      {
        input: {
          counts: { failed: 0, planned: 2, pushed: 1 },
          error: "Run cancelled by user",
          status: "cancelled",
          syncRunId,
        },
      },
      dependencies(),
    );

    const run = await readRun(syncRunId);
    expect(run.status).toBe("cancelled");
    expect(run.counts).toEqual({ failed: 0, planned: 2, pushed: 1 });
    expect(run.error).toBe("Run cancelled by user");
  });

  it("marks failed runs with error text", async () => {
    const syncRunId = await insertRun("running");

    await finalizeSyncRun(
      {
        input: {
          counts: { failed: 1, pushed: 0, planned: 1 },
          error: "1 item(s) failed during push",
          status: "failed",
          syncRunId,
        },
      },
      dependencies(),
    );

    const run = await readRun(syncRunId);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("1 item(s) failed during push");
  });

  it("accepts an exact terminal-status replay without updating details", async () => {
    const syncRunId = await insertRun("completed");

    const result = await finalizeSyncRun(
      { input: { counts: { planned: 2, pushed: 2 }, status: "completed", syncRunId } },
      dependencies(),
    );

    expect(result).toEqual({ status: "database" });
    // The row is only written by the guarded update, which matched nothing.
    expect((await readRun(syncRunId)).counts).toEqual({});
  });

  it("rejects a cancelled run finalized as completed", async () => {
    const syncRunId = await insertRun("cancelled");

    await expect(
      finalizeSyncRun(
        { input: { counts: { planned: 2, pushed: 2 }, status: "completed", syncRunId } },
        dependencies(),
      ),
    ).rejects.toThrow("Unable to finalize sync run.");
    expect((await readRun(syncRunId)).status).toBe("cancelled");
  });

  it("rejects a completed run finalized as failed", async () => {
    const syncRunId = await insertRun("completed");

    await expect(
      finalizeSyncRun(
        { input: { error: "1 item(s) failed during push", status: "failed", syncRunId } },
        dependencies(),
      ),
    ).rejects.toThrow("Unable to finalize sync run.");
    expect((await readRun(syncRunId)).status).toBe("completed");
  });
});

describe("completeSyncedObject", () => {
  it("performs all writes inside a transaction after HEAD attestation", async () => {
    const { db } = testDatabase();
    const syncRunId = await insertRun("running");

    const result = await completeSyncedObject(
      { input: { ...uploadInput, syncRunId }, storage },
      dependencies(),
    );

    expect(result).toEqual({ status: "database" });
    expect(headStoredObject).toHaveBeenCalledWith(expect.objectContaining({ key: "objects/abc" }));

    const [media] = await db.select().from(mediaObjects);
    expect(media).toMatchObject({ objectKey: "objects/abc", sha256, size: 1024 });
    expect(await db.select({ path: folders.path }).from(folders)).toEqual([{ path: "photos" }]);
    const [entry] = await db.select().from(libraryEntries);
    expect(entry).toMatchObject({
      filename: "photo.jpg",
      logicalPath: "photos/photo.jpg",
      mediaObjectId: media?.id,
      parentPath: "photos",
    });
    const [item] = await db.select().from(syncRunItems);
    expect(item).toMatchObject({
      action: "upload",
      logicalPath: "photos/photo.jpg",
      mediaObjectId: media?.id,
      syncRunId,
    });
  });

  it("rejects missing storage objects before opening a transaction", async () => {
    const syncRunId = await insertRun("running");
    headStoredObject.mockResolvedValue(null);

    await expect(
      completeSyncedObject({ input: { ...uploadInput, syncRunId }, storage }, dependencies()),
    ).rejects.toThrow("Uploaded object was not found in storage.");

    expect(await testDatabase().db.select().from(mediaObjects)).toEqual([]);
  });

  it("rejects size mismatches before opening a transaction", async () => {
    const syncRunId = await insertRun("running");
    headStoredObject.mockResolvedValue({
      checksumSHA256: undefined,
      contentLength: 10,
      contentType: "image/jpeg",
      etag: '"etag"',
      metadata: undefined,
    });

    await expect(
      completeSyncedObject({ input: { ...uploadInput, syncRunId }, storage }, dependencies()),
    ).rejects.toThrow("Uploaded object size does not match declared size.");

    expect(await testDatabase().db.select().from(mediaObjects)).toEqual([]);
  });

  it("rejects non-running sync runs without mutating media objects", async () => {
    const { db } = testDatabase();
    const syncRunId = await insertRun("completed");

    await expect(
      completeSyncedObject({ input: { ...uploadInput, syncRunId }, storage }, dependencies()),
    ).rejects.toThrow("Sync run is not accepting writes.");

    expect(await db.select().from(mediaObjects)).toEqual([]);
    expect(await db.select().from(libraryEntries)).toEqual([]);
    expect(await db.select().from(syncRunItems)).toEqual([]);
  });
});

describe("markRemoteDeleted", () => {
  async function seedEntry(syncRunId: string): Promise<void> {
    await completeSyncedObject({ input: { ...uploadInput, syncRunId }, storage }, dependencies());
  }

  it("validates the sync run before updating library entries", async () => {
    const { db } = testDatabase();
    const syncRunId = await insertRun("running");
    await seedEntry(syncRunId);

    const result = await markRemoteDeleted(
      { logicalPath: "photos/photo.jpg", syncRunId },
      dependencies(),
    );

    expect(result).toEqual({ status: "database" });
    const [entry] = await db.select().from(libraryEntries);
    expect(entry?.deletedAt).toBeInstanceOf(Date);
    const items = await db.select().from(syncRunItems);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      action: "delete",
      logicalPath: "photos/photo.jpg",
      syncRunId,
    });
  });

  it("rejects missing sync runs without mutating library entries", async () => {
    const { db } = testDatabase();
    const syncRunId = await insertRun("running");
    await seedEntry(syncRunId);

    await expect(
      markRemoteDeleted(
        {
          logicalPath: "photos/photo.jpg",
          syncRunId: "00000000-0000-4000-8000-000000000001",
        },
        dependencies(),
      ),
    ).rejects.toThrow("Sync run not found.");

    const [entry] = await db.select().from(libraryEntries);
    expect(entry?.deletedAt).toBeNull();
  });

  it("rejects non-running sync runs without mutating library entries", async () => {
    const { db } = testDatabase();
    const syncRunId = await insertRun("running");
    await seedEntry(syncRunId);
    const closedRunId = await insertRun("completed");

    await expect(
      markRemoteDeleted(
        { logicalPath: "photos/photo.jpg", syncRunId: closedRunId },
        dependencies(),
      ),
    ).rejects.toThrow("Sync run is not accepting writes.");

    const [entry] = await db.select().from(libraryEntries);
    expect(entry?.deletedAt).toBeNull();
    expect(await db.select().from(syncRunItems)).toHaveLength(1);
  });
});
