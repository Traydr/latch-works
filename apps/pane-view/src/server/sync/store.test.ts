import { eq, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { folders, libraryEntries, mediaObjects, syncRunItems, syncRuns } from "../db/schema";
import { testDatabaseForSuite } from "../library/test-db";
import type { StoredObjectHead } from "../media/storage-client";
import type { SyncStoreDependencies } from "./store";
import { completeSyncedObject, markRemoteDeleted } from "./store";
import { finalizeSyncRun } from "./sync-runs";

/**
 * The sync writes against executed SQL: the archive is a real database, and
 * only the object storage HEAD attestation stands in.
 */

const testDatabase = testDatabaseForSuite();

/** What object storage holds at `objects/abc`, the key every upload here declares. */
let storedHead: StoredObjectHead | null;

function dependencies(): SyncStoreDependencies {
  return {
    database: testDatabase().db,
    headStoredObject: async (key) => (key === "objects/abc" ? storedHead : null),
  };
}

const sha256 = "abc123".padEnd(64, "0");

const attestedHead: StoredObjectHead = {
  checksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
  contentLength: 1024,
  contentType: "image/jpeg",
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
  storedHead = attestedHead;
});

describe("finalizeSyncRun", () => {
  it("marks completed runs with final counts", async () => {
    const syncRunId = await insertRun("running");

    await finalizeSyncRun(
      syncRunId,
      { counts: { pushed: 2, planned: 2 }, error: null, status: "completed" },
      testDatabase().db,
    );

    const run = await readRun(syncRunId);
    expect(run.status).toBe("completed");
    expect(run.counts).toEqual({ pushed: 2, planned: 2 });
    expect(run.error).toBeNull();
    expect(run.completedAt).toBeInstanceOf(Date);
  });

  it("marks cancelled runs with error text", async () => {
    const syncRunId = await insertRun("running");

    await finalizeSyncRun(
      syncRunId,
      {
        counts: { failed: 0, planned: 2, pushed: 1 },
        error: "Run cancelled by user",
        status: "cancelled",
      },
      testDatabase().db,
    );

    const run = await readRun(syncRunId);
    expect(run.status).toBe("cancelled");
    expect(run.counts).toEqual({ failed: 0, planned: 2, pushed: 1 });
    expect(run.error).toBe("Run cancelled by user");
  });

  it("accepts an exact terminal-status replay without updating details", async () => {
    const syncRunId = await insertRun("completed");

    await finalizeSyncRun(
      syncRunId,
      { counts: { planned: 2, pushed: 2 }, error: null, status: "completed" },
      testDatabase().db,
    );

    // The row is only written by the guarded update, which matched nothing.
    expect((await readRun(syncRunId)).counts).toEqual({});
  });

  it("rejects a cancelled run finalized as completed", async () => {
    const syncRunId = await insertRun("cancelled");

    await expect(
      finalizeSyncRun(
        syncRunId,
        { counts: { planned: 2, pushed: 2 }, error: null, status: "completed" },
        testDatabase().db,
      ),
    ).rejects.toThrow("Sync run is already cancelled.");
    expect((await readRun(syncRunId)).status).toBe("cancelled");
  });

  it("rejects a completed run finalized as failed", async () => {
    const syncRunId = await insertRun("completed");

    await expect(
      finalizeSyncRun(
        syncRunId,
        { counts: {}, error: "1 item(s) failed during push", status: "failed" },
        testDatabase().db,
      ),
    ).rejects.toThrow("Sync run is already completed.");
    expect((await readRun(syncRunId)).status).toBe("completed");
  });
});

describe("completeSyncedObject", () => {
  it("registers the attested object with its folder, entry and run item", async () => {
    const { db } = testDatabase();
    const syncRunId = await insertRun("running");

    await completeSyncedObject({ ...uploadInput, syncRunId }, dependencies());

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
    storedHead = null;

    await expect(
      completeSyncedObject({ ...uploadInput, syncRunId }, dependencies()),
    ).rejects.toThrow("Uploaded object was not found in storage.");

    expect(await testDatabase().db.select().from(mediaObjects)).toEqual([]);
  });

  it("rejects size mismatches before opening a transaction", async () => {
    const syncRunId = await insertRun("running");
    storedHead = {
      checksumSHA256: undefined,
      contentLength: 10,
      contentType: "image/jpeg",
      metadata: undefined,
    };

    await expect(
      completeSyncedObject({ ...uploadInput, syncRunId }, dependencies()),
    ).rejects.toThrow("Uploaded object size does not match declared size.");

    expect(await testDatabase().db.select().from(mediaObjects)).toEqual([]);
  });

  it("rejects non-running sync runs without mutating media objects", async () => {
    const { db } = testDatabase();
    const syncRunId = await insertRun("completed");

    await expect(
      completeSyncedObject({ ...uploadInput, syncRunId }, dependencies()),
    ).rejects.toThrow("Sync run is not accepting writes.");

    expect(await db.select().from(mediaObjects)).toEqual([]);
    expect(await db.select().from(libraryEntries)).toEqual([]);
    expect(await db.select().from(syncRunItems)).toEqual([]);
  });
});

describe("markRemoteDeleted", () => {
  async function seedEntry(syncRunId: string): Promise<void> {
    await completeSyncedObject({ ...uploadInput, syncRunId }, dependencies());
  }

  it("validates the sync run before updating library entries", async () => {
    const { db } = testDatabase();
    const syncRunId = await insertRun("running");
    await seedEntry(syncRunId);

    await markRemoteDeleted({ logicalPath: "photos/photo.jpg", syncRunId }, testDatabase().db);

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
        testDatabase().db,
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
        testDatabase().db,
      ),
    ).rejects.toThrow("Sync run is not accepting writes.");

    const [entry] = await db.select().from(libraryEntries);
    expect(entry?.deletedAt).toBeNull();
    expect(await db.select().from(syncRunItems)).toHaveLength(1);
  });
});

describe("folder lifecycle", () => {
  async function upload(syncRunId: string, logicalPath: string): Promise<void> {
    const filename = logicalPath.split("/").at(-1) ?? logicalPath;

    await completeSyncedObject(
      { ...uploadInput, filename, logicalPath, syncRunId },
      dependencies(),
    );
  }

  async function finalize(syncRunId: string): Promise<void> {
    await finalizeSyncRun(
      syncRunId,
      { counts: {}, error: null, status: "completed" },
      testDatabase().db,
    );
  }

  async function liveFolderPaths(): Promise<string[]> {
    const rows = await testDatabase()
      .db.select({ path: folders.path })
      .from(folders)
      .where(isNull(folders.deletedAt));

    return rows.map((row) => row.path).sort();
  }

  it("brings a deleted folder back when its files are synced again", async () => {
    const { db } = testDatabase();
    const firstRun = await insertRun("running");
    await upload(firstRun, "photos/2026/photo.jpg");
    await finalize(firstRun);
    // What Manage's folder delete leaves behind.
    await db.update(libraryEntries).set({ deletedAt: new Date() });
    await db.update(folders).set({ deletedAt: new Date() });

    const secondRun = await insertRun("running");
    await upload(secondRun, "photos/2026/photo.jpg");
    await finalize(secondRun);

    expect(await liveFolderPaths()).toEqual(["photos", "photos/2026"]);
  });

  it("soft-deletes folders a run emptied or renamed away, up the tree", async () => {
    const seedRun = await insertRun("running");

    for (const path of [
      "photos/old/2026/photo.jpg",
      "photos/keep/photo.jpg",
      "Photos/photo.jpg",
      "trips/photo.jpg",
    ]) {
      await upload(seedRun, path);
    }

    await finalize(seedRun);

    const run = await insertRun("running");
    // A local rename of photos/old to photos/new, and trips emptied outright.
    await upload(run, "photos/new/2026/photo.jpg");
    await markRemoteDeleted(
      { logicalPath: "photos/old/2026/photo.jpg", syncRunId: run },
      testDatabase().db,
    );
    await markRemoteDeleted({ logicalPath: "trips/photo.jpg", syncRunId: run }, testDatabase().db);

    // Nothing moves until the run finalizes.
    expect(await liveFolderPaths()).toContain("photos/old/2026");

    await finalize(run);

    expect(await liveFolderPaths()).toEqual([
      "Photos",
      "photos",
      "photos/keep",
      "photos/new",
      "photos/new/2026",
    ]);
  });
});
