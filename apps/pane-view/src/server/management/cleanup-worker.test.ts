import { beforeEach, describe, expect, it } from "vitest";
import {
  folders,
  libraryEntries,
  maintenanceJobs,
  mediaObjects,
  shutterSourceCleanup,
} from "../db/schema";
import { testDatabaseForSuite } from "../library/test-db";
import { type MaintenanceWorkerDependencies, processMaintenanceJobBatch } from "./cleanup-worker";
import { initialProgressFor } from "./maintenance-progress";

const testDatabase = testDatabaseForSuite();

/** What the fake object storage and Shutter were asked to delete. */
interface ExternalDeletes {
  objectKeys: string[];
  shutterSources: string[];
}

function dependencies(deletes?: ExternalDeletes): MaintenanceWorkerDependencies {
  return {
    database: testDatabase().db,
    deleteObjects: async (keys) => {
      deletes?.objectKeys.push(...keys);

      return { deleted: keys.length };
    },
    listObjectsByPrefix: async () => ({ keys: [], nextContinuationToken: undefined }),
    purgeShutterSource: async (source) => {
      deletes?.shutterSources.push(source.sha256);
    },
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
