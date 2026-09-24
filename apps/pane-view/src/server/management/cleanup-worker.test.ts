import type { S3StorageClient } from "@latch-works/media-storage";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  folders,
  libraryEntries,
  maintenanceJobs,
  mediaObjects,
  shutterSourceCleanup,
  syncRunItems,
  syncRuns,
} from "../db/schema";
import { testDatabaseForSuite } from "../library/test-db";
import { completeSyncedObject, markRemoteDeleted, type SyncStoreDependencies } from "../sync/store";
import { cancelMaintenanceJob } from "./cleanup-control";
import {
  type MaintenanceWorkerDependencies,
  processMaintenanceJob,
  processMaintenanceJobBatch,
} from "./cleanup-worker";
import { initialProgressFor } from "./maintenance-progress";
import { hasPurgeableShutterSources } from "./shutter-source-purge";

const testDatabase = testDatabaseForSuite();

/** What the fake object storage and Shutter were asked to delete. */
interface ExternalDeletes {
  objectKeys: string[];
  shutterSources: string[];
}

function dependencies(deletes?: ExternalDeletes): MaintenanceWorkerDependencies {
  return {
    // pglite is one session, so an advisory claim could never contend; run the batch unclaimed.
    claimJobBatch: (_jobId, batch) => batch(),
    database: testDatabase().db,
    deleteObjects: async (keys) => {
      deletes?.objectKeys.push(...keys);

      return { deleted: keys.length };
    },
    listObjectsByPrefix: async () => ({ keys: [], nextContinuationToken: undefined }),
    purgeShutterSource: async (source) => {
      deletes?.shutterSources.push(source.sha256);
    },
    shutterPurgeReadiness: () => "ready",
  };
}

async function runJobToCompletion(jobId: string, deletes?: ExternalDeletes): Promise<void> {
  while (await processMaintenanceJobBatch(jobId, dependencies(deletes))) {
    // Each batch advances the durable cursor; the job reports when it is done.
  }
}

async function insertMediaObject(sha256: string): Promise<string> {
  const [object] = await testDatabase()
    .db.insert(mediaObjects)
    .values({
      contentType: "image/jpeg",
      extension: "jpg",
      mediaType: "image",
      objectKey: `originals/${sha256}.jpg`,
      sha256,
      size: 1024,
    })
    .returning({ id: mediaObjects.id });

  if (!object) throw new Error("failed to insert media object");

  return object.id;
}

async function insertEntry(
  mediaObjectId: string,
  logicalPath: string,
  deletedAt: Date | null,
): Promise<void> {
  await testDatabase()
    .db.insert(libraryEntries)
    .values({
      deletedAt,
      filename: logicalPath.split("/").at(-1) ?? logicalPath,
      logicalPath,
      mediaObjectId,
      mtimeMs: 1_700_000_000_000,
      parentPath: logicalPath.includes("/")
        ? logicalPath.slice(0, logicalPath.lastIndexOf("/"))
        : "",
      size: 1024,
    });
}

async function insertJob(
  type: "shutter_source_purge" | "soft_deleted_purge" | "library_hard_wipe",
): Promise<string> {
  const [job] = await testDatabase()
    .db.insert(maintenanceJobs)
    .values({ progress: initialProgressFor(type), status: "pending", type })
    .returning({ id: maintenanceJobs.id });

  if (!job) throw new Error("failed to insert maintenance job");

  return job.id;
}

async function remainingMediaSha256s(): Promise<string[]> {
  const rows = await testDatabase().db.select({ sha256: mediaObjects.sha256 }).from(mediaObjects);

  return rows.map((row) => row.sha256).sort();
}

describe("soft-deleted purge", () => {
  beforeEach(async () => {
    const { db } = testDatabase();
    await db.delete(libraryEntries);
    await db.delete(folders);
    await db.delete(mediaObjects);
    await db.delete(maintenanceJobs);
    await db.delete(shutterSourceCleanup);
  });

  it("reclaims media no live entry references, including media no entry references", async () => {
    const deletedAt = new Date();
    const unreferenced = "a".repeat(64);
    const deletedOnly = "b".repeat(64);
    const shared = "c".repeat(64);
    const live = "d".repeat(64);

    // The original a content change left behind: sync repointed its entry elsewhere.
    await insertMediaObject(unreferenced);
    await insertEntry(await insertMediaObject(deletedOnly), "gone/a.jpg", deletedAt);
    const sharedId = await insertMediaObject(shared);
    await insertEntry(sharedId, "gone/b.jpg", deletedAt);
    await insertEntry(sharedId, "kept/b.jpg", null);
    await insertEntry(await insertMediaObject(live), "kept/c.jpg", null);

    const deletes: ExternalDeletes = { objectKeys: [], shutterSources: [] };
    await runJobToCompletion(await insertJob("soft_deleted_purge"), deletes);

    expect(deletes.objectKeys.sort()).toEqual([
      `originals/${unreferenced}.jpg`,
      `originals/${deletedOnly}.jpg`,
    ]);
    expect(await remainingMediaSha256s()).toEqual([shared, live]);

    const queued = await testDatabase()
      .db.select({ sha256: shutterSourceCleanup.sha256 })
      .from(shutterSourceCleanup);

    expect(queued.map((row) => row.sha256).sort()).toEqual([unreferenced, deletedOnly]);
  });

  it("keeps every media row when a cancel lands during the storage delete", async () => {
    const sha256s = ["1", "2", "3"].map((digit) => digit.repeat(64));

    for (const sha256 of sha256s) {
      await insertEntry(await insertMediaObject(sha256), `gone/${sha256[0]}.jpg`, new Date());
    }

    const jobId = await insertJob("soft_deleted_purge");

    const cancelling: MaintenanceWorkerDependencies = {
      ...dependencies(),
      deleteObjects: async (keys) => {
        await cancelMaintenanceJob({ jobId }, testDatabase().db);

        return { deleted: keys.length };
      },
    };

    expect(await processMaintenanceJobBatch(jobId, cancelling)).toBe(false);
    expect(await remainingMediaSha256s()).toEqual(sha256s);
    expect(await testDatabase().db.select().from(shutterSourceCleanup)).toEqual([]);
  });

  it("hard-deletes deleted folders unless something live sits beneath them", async () => {
    const { db } = testDatabase();
    const deletedAt = new Date();

    const [object] = await db
      .insert(mediaObjects)
      .values({
        contentType: "image/jpeg",
        extension: "jpg",
        mediaType: "image",
        objectKey: "originals/seed.jpg",
        sha256: "a".repeat(64),
        size: 1024,
      })
      .returning({ id: mediaObjects.id });

    if (!object) throw new Error("failed to insert media object");

    const folderIds = new Map<string, string>();

    for (const { deleted, path } of [
      { deleted: true, path: "gone" },
      { deleted: true, path: "gone/sub" },
      { deleted: true, path: "kept" },
      { deleted: false, path: "kept/sub" },
      { deleted: true, path: "shell" },
      { deleted: false, path: "shell/child" },
    ]) {
      const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

      const [row] = await db
        .insert(folders)
        .values({
          deletedAt: deleted ? deletedAt : null,
          name: path.split("/").at(-1) ?? path,
          parentId: folderIds.get(parentPath) ?? null,
          parentPath,
          path,
        })
        .returning({ id: folders.id });

      if (!row) throw new Error(`failed to insert folder ${path}`);

      folderIds.set(path, row.id);
    }

    for (const { deleted, logicalPath } of [
      { deleted: true, logicalPath: "gone/sub/a.jpg" },
      { deleted: false, logicalPath: "kept/sub/b.jpg" },
    ]) {
      await db.insert(libraryEntries).values({
        deletedAt: deleted ? deletedAt : null,
        filename: logicalPath.split("/").at(-1) ?? logicalPath,
        logicalPath,
        mediaObjectId: object.id,
        mtimeMs: 1_700_000_000_000,
        parentPath: logicalPath.slice(0, logicalPath.lastIndexOf("/")),
        size: 1024,
      });
    }

    const [job] = await db
      .insert(maintenanceJobs)
      .values({
        progress: initialProgressFor("soft_deleted_purge"),
        status: "pending",
        type: "soft_deleted_purge",
      })
      .returning({ id: maintenanceJobs.id });

    if (!job) throw new Error("failed to insert maintenance job");

    await runJobToCompletion(job.id);

    const remaining = await db
      .select({ deletedAt: folders.deletedAt, path: folders.path })
      .from(folders);

    // A folder row cascades to its children, so `kept` and `shell` must stay
    // for `kept/sub` and `shell/child` to survive.
    expect(
      remaining.map((row) => `${row.path}${row.deletedAt ? " (deleted)" : ""}`).sort(),
    ).toEqual(["kept (deleted)", "kept/sub", "shell (deleted)", "shell/child"]);
    expect(
      (await db.select({ path: libraryEntries.logicalPath }).from(libraryEntries)).map(
        (row) => row.path,
      ),
    ).toEqual(["kept/sub/b.jpg"]);
  });
});

describe("Shutter source purge", () => {
  beforeEach(async () => {
    const { db } = testDatabase();
    await db.delete(syncRunItems);
    await db.delete(syncRuns);
    await db.delete(libraryEntries);
    await db.delete(mediaObjects);
    await db.delete(maintenanceJobs);
    await db.delete(shutterSourceCleanup);
  });

  function hasPurgeableSources(): Promise<boolean> {
    return testDatabase().db.transaction((tx) => hasPurgeableShutterSources(tx));
  }

  it("purges a source again after its content is synced and deleted again", async () => {
    const { db } = testDatabase();
    const sha256 = "e".repeat(64);
    const objectKey = `originals/${sha256}.jpg`;
    await insertEntry(await insertMediaObject(sha256), "gone/e.jpg", new Date());

    const deletes: ExternalDeletes = { objectKeys: [], shutterSources: [] };
    await runJobToCompletion(await insertJob("shutter_source_purge"), deletes);
    expect(deletes.shutterSources).toEqual([sha256]);
    expect(await hasPurgeableSources()).toBe(false);

    // Synced again, served again, then deleted again.
    const [run] = await db
      .insert(syncRuns)
      .values({ sourceRoot: "/archive", status: "running" })
      .returning({ id: syncRuns.id });

    if (!run) throw new Error("failed to insert sync run");

    const syncDependencies: SyncStoreDependencies = {
      acquireLibraryMutationStartupLock: async () => undefined,
      assertNoActiveCleanupJob: async () => undefined,
      database: db,
      headStoredObject: async () => ({
        checksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
        contentLength: 1024,
        contentType: "image/jpeg",
        etag: '"etag"',
        metadata: { sha256 },
      }),
    };

    // SAFETY: the faked headStoredObject is the only call that receives this client.
    const storage = { bucket: "test-bucket", client: {} as S3StorageClient["client"] };

    await completeSyncedObject(
      {
        input: {
          contentType: "image/jpeg",
          extension: "jpg",
          filename: "e.jpg",
          logicalPath: "gone/e.jpg",
          mediaType: "image",
          mtimeMs: 1_700_000_000_000,
          objectKey,
          sha256,
          size: 1024,
          syncRunId: run.id,
        },
        storage,
      },
      syncDependencies,
    );
    await markRemoteDeleted({ logicalPath: "gone/e.jpg", syncRunId: run.id }, syncDependencies);
    await db.delete(maintenanceJobs);

    expect(await hasPurgeableSources()).toBe(true);
    await runJobToCompletion(await insertJob("shutter_source_purge"), deletes);
    expect(deletes.shutterSources).toEqual([sha256, sha256]);
  });

  it("drops a queued source whose content is live again instead of purging it", async () => {
    const { db } = testDatabase();
    const sha256 = "f".repeat(64);
    await insertEntry(await insertMediaObject(sha256), "kept/f.jpg", null);
    await db.insert(shutterSourceCleanup).values({ objectKey: `originals/${sha256}.jpg`, sha256 });

    expect(await hasPurgeableSources()).toBe(false);

    const deletes: ExternalDeletes = { objectKeys: [], shutterSources: [] };
    await runJobToCompletion(await insertJob("shutter_source_purge"), deletes);

    expect(deletes.shutterSources).toEqual([]);
    expect(await db.select().from(shutterSourceCleanup)).toEqual([]);
  });
});

describe("library wipe", () => {
  beforeEach(async () => {
    const { db } = testDatabase();
    await db.delete(libraryEntries);
    await db.delete(mediaObjects);
    await db.delete(maintenanceJobs);
  });

  it("deletes nothing while Shutter is partly configured", async () => {
    const sha256 = "9".repeat(64);
    await insertEntry(await insertMediaObject(sha256), "gone/9.jpg", new Date());
    const jobId = await insertJob("library_hard_wipe");
    const deletes: ExternalDeletes = { objectKeys: [], shutterSources: [] };

    await expect(
      processMaintenanceJobBatch(jobId, {
        ...dependencies(deletes),
        shutterPurgeReadiness: () => "incomplete",
      }),
    ).rejects.toThrow("Shutter is partly configured");
    expect(deletes).toEqual({ objectKeys: [], shutterSources: [] });
    expect(await remainingMediaSha256s()).toEqual([sha256]);
  });

  it("skips the purge but still wipes when there is no Shutter at all", async () => {
    const sha256 = "8".repeat(64);
    await insertEntry(await insertMediaObject(sha256), "gone/8.jpg", new Date());
    const deletes: ExternalDeletes = { objectKeys: [], shutterSources: [] };

    const jobId = await insertJob("library_hard_wipe");

    while (
      await processMaintenanceJobBatch(jobId, {
        ...dependencies(deletes),
        shutterPurgeReadiness: () => "off",
      })
    ) {
      // Each batch advances the durable cursor; the job reports when it is done.
    }

    expect(deletes).toEqual({ objectKeys: [`originals/${sha256}.jpg`], shutterSources: [] });
    expect(await remainingMediaSha256s()).toEqual([]);
  });
});

describe("maintenance job claims", () => {
  beforeEach(async () => {
    const { db } = testDatabase();
    await db.delete(libraryEntries);
    await db.delete(mediaObjects);
    await db.delete(maintenanceJobs);
  });

  it("retries a job another worker holds instead of abandoning it", async () => {
    vi.useFakeTimers();

    try {
      const jobId = await insertJob("soft_deleted_purge");
      let attempts = 0;

      const readStatus = async () => {
        const [job] = await testDatabase()
          .db.select({ status: maintenanceJobs.status })
          .from(maintenanceJobs)
          .where(eq(maintenanceJobs.id, jobId));

        return job?.status;
      };

      processMaintenanceJob(jobId, {
        ...dependencies(),
        claimJobBatch: async (_jobId, batch) => {
          attempts += 1;

          return attempts === 1 ? "contended" : batch();
        },
      });

      await vi.waitFor(() => expect(attempts).toBe(1));
      expect(await readStatus()).toBe("pending");

      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(async () => expect(await readStatus()).toBe("completed"));
    } finally {
      vi.useRealTimers();
    }
  });
});
