import { beforeEach, describe, expect, it } from "vitest";
import { folders, libraryEntries, maintenanceJobs, mediaObjects } from "../db/schema";
import { testDatabaseForSuite } from "../library/test-db";
import { type MaintenanceWorkerDependencies, processMaintenanceJobBatch } from "./cleanup-worker";
import { initialProgressFor } from "./maintenance-progress";

const testDatabase = testDatabaseForSuite();

function dependencies(): MaintenanceWorkerDependencies {
  return {
    database: testDatabase().db,
    deleteObjects: async (keys) => ({ deleted: keys.length }),
    listObjectsByPrefix: async () => ({ keys: [], nextContinuationToken: undefined }),
    purgeShutterSource: async () => undefined,
  };
}

async function runJobToCompletion(jobId: string): Promise<void> {
  while (await processMaintenanceJobBatch(jobId, dependencies())) {
    // Each batch advances the durable cursor; the job reports when it is done.
  }
}

describe("soft-deleted purge", () => {
  beforeEach(async () => {
    const { db } = testDatabase();
    await db.delete(libraryEntries);
    await db.delete(folders);
    await db.delete(mediaObjects);
    await db.delete(maintenanceJobs);
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
