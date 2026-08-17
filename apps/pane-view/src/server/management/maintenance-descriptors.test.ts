import { eq, isNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Each descriptor's own probe and prepare step, and the shared orphaned-source
 * eligibility, against executed SQL (Plan 051's pglite harness). The
 * scheduling prologue around them is covered in maintenance-scheduler.test.ts.
 */

const harness = vi.hoisted(() => ({
  handle: null as null | {
    client: { exec(sql: string): Promise<unknown> };
    close(): Promise<void>;
  },
}));

vi.mock("../db", async () => {
  const { createTestDatabase } = await import("../library/test-db");
  const handle = await createTestDatabase();
  harness.handle = handle;
  return { db: handle.db };
});
vi.mock("../auth/api-token", () => ({ assertSyncApiTokenFromBody: vi.fn() }));
vi.mock("./cleanup-worker", () => ({ processMaintenanceJob: vi.fn() }));

import { assertSyncApiTokenFromBody } from "../auth/api-token";
import { db } from "../db";
import {
  collections,
  favorites,
  folders,
  libraryEntries,
  maintenanceJobs,
  mediaObjects,
  shutterSourceCleanup,
} from "../db/schema";
import { processMaintenanceJob } from "./cleanup-worker";
import {
  LIBRARY_WIPE_CONFIRMATION,
  scheduleLibraryWipe,
  softDeleteWholeLibrary,
} from "./library-wipe";
import { orphanedMediaObjectCondition, orphanedShutterSourceCondition } from "./orphaned-sources";
import { hasPurgeableShutterSources } from "./shutter-source-purge";
import { hasSoftDeletedEntries } from "./soft-deleted-purge";

afterAll(async () => {
  await harness.handle?.close();
});

const objectId = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;

async function resetLibrary() {
  await harness.handle?.client.exec(
    "delete from maintenance_jobs; delete from shutter_source_cleanup; delete from favorites; " +
      "delete from collection_items; delete from collections; delete from library_entries; " +
      "delete from folders; delete from media_objects;",
  );
}

async function insertObject(n: number) {
  await db.insert(mediaObjects).values({
    contentType: "image/jpeg",
    extension: "jpg",
    id: objectId(n),
    mediaType: "image",
    objectKey: `objects/${n}`,
    sha256: `sha-${n}`.padEnd(64, "0"),
    size: 100,
  });
}

async function insertEntry(n: number, path: string, deleted: boolean) {
  await db.insert(libraryEntries).values({
    deletedAt: deleted ? new Date("2026-08-01T00:00:00Z") : null,
    filename: path.slice(path.lastIndexOf("/") + 1),
    logicalPath: path,
    mediaObjectId: objectId(n),
    mtimeMs: 1,
    parentPath: path.slice(0, path.lastIndexOf("/")),
  });
}

describe("orphaned source eligibility", () => {
  beforeEach(resetLibrary);

  it("selects media objects referenced only by soft-deleted entries", async () => {
    await insertObject(1); // one deleted, one live → shared, not orphaned
    await insertEntry(1, "a/shared-live.jpg", false);
    await insertEntry(1, "a/shared-deleted.jpg", true);
    await insertObject(2); // only deleted → orphaned
    await insertEntry(2, "a/gone.jpg", true);
    await insertObject(3); // only live → not orphaned
    await insertEntry(3, "a/kept.jpg", false);
    await insertObject(4); // unreferenced → not orphaned (no deleted reference)
    await db.insert(shutterSourceCleanup).values({ sha256: `sha-2`.padEnd(64, "0") });

    const orphaned = await db
      .select({ id: mediaObjects.id })
      .from(mediaObjects)
      .where(orphanedMediaObjectCondition());
    expect(orphaned.map((row) => row.id)).toEqual([objectId(2)]);

    const unqueued = await db
      .select({ id: mediaObjects.id })
      .from(mediaObjects)
      .where(orphanedShutterSourceCondition());
    expect(unqueued).toEqual([]);
  });

  it("renders the same predicate the purge probes and batches used to inline", () => {
    const sql = db
      .select({ id: mediaObjects.id })
      .from(mediaObjects)
      .where(orphanedMediaObjectCondition())
      .toSQL().sql;
    expect(sql.replace(/\s+/gu, " ")).toBe(
      'select "id" from "media_objects" where (exists (select 1 from "library_entries" where ' +
        '("library_entries"."media_object_id" = "media_objects"."id" and "library_entries"."deleted_at" is not null)) ' +
        'and not exists (select 1 from "library_entries" where ' +
        '("library_entries"."media_object_id" = "media_objects"."id" and "library_entries"."deleted_at" is null)))',
    );
  });
});

describe("purge probes", () => {
  beforeEach(resetLibrary);

  it("soft-deleted purge has work only when a soft-deleted entry exists", async () => {
    await insertObject(1);
    await insertEntry(1, "a/live.jpg", false);
    expect(await db.transaction((tx) => hasSoftDeletedEntries(tx))).toBe(false);
    await insertObject(2);
    await insertEntry(2, "a/gone.jpg", true);
    expect(await db.transaction((tx) => hasSoftDeletedEntries(tx))).toBe(true);
  });

  it("shutter purge has work for a queued unpurged source or an orphaned object", async () => {
    expect(await db.transaction((tx) => hasPurgeableShutterSources(tx))).toBe(false);
    await db
      .insert(shutterSourceCleanup)
      .values({ purgedAt: new Date(), sha256: "done".padEnd(64, "0") });
    expect(await db.transaction((tx) => hasPurgeableShutterSources(tx))).toBe(false);
    await db.insert(shutterSourceCleanup).values({ sha256: "queued".padEnd(64, "0") });
    expect(await db.transaction((tx) => hasPurgeableShutterSources(tx))).toBe(true);

    await harness.handle?.client.exec("delete from shutter_source_cleanup");
    await insertObject(2);
    await insertEntry(2, "a/gone.jpg", true);
    expect(await db.transaction((tx) => hasPurgeableShutterSources(tx))).toBe(true);
  });
});

describe("library wipe", () => {
  beforeEach(async () => {
    await resetLibrary();
    vi.mocked(assertSyncApiTokenFromBody).mockReset();
    vi.mocked(processMaintenanceJob).mockReset();
  });

  it("requires the confirmation string and the sync token before scheduling anything", async () => {
    await expect(scheduleLibraryWipe({ confirmation: "wipe", syncToken: "t" })).rejects.toThrow(
      `Type "${LIBRARY_WIPE_CONFIRMATION}" to confirm.`,
    );
    expect(assertSyncApiTokenFromBody).not.toHaveBeenCalled();

    vi.mocked(assertSyncApiTokenFromBody).mockImplementationOnce(() => {
      throw new Error("bad token");
    });
    await expect(
      scheduleLibraryWipe({ confirmation: LIBRARY_WIPE_CONFIRMATION, syncToken: "t" }),
    ).rejects.toThrow("bad token");
    expect(await db.select().from(maintenanceJobs)).toEqual([]);
  });

  it("soft-deletes the whole library and drops derived rows inside the scheduling transaction", async () => {
    await db.insert(folders).values({ name: "a", path: "a" });
    await insertObject(1);
    await insertEntry(1, "a/live.jpg", false);
    await db.insert(collections).values({ name: "c", path: "a", type: "folder" });

    await db.transaction((tx) => softDeleteWholeLibrary(tx));

    expect(await db.select().from(libraryEntries).where(isNull(libraryEntries.deletedAt))).toEqual(
      [],
    );
    expect(await db.select().from(folders).where(isNull(folders.deletedAt))).toEqual([]);
    expect(await db.select().from(collections)).toEqual([]);
    expect(await db.select().from(favorites)).toEqual([]);
    // Objects stay: the worker purges storage before the hard delete.
    expect(await db.select().from(mediaObjects)).toHaveLength(1);
  });

  it("schedules a hard wipe with the wipe's initial progress even for an empty library", async () => {
    const result = await scheduleLibraryWipe({
      confirmation: LIBRARY_WIPE_CONFIRMATION,
      syncToken: "t",
    });
    expect(result.phase).toBe("scheduled");
    const [job] = await db
      .select()
      .from(maintenanceJobs)
      .where(eq(maintenanceJobs.id, result.jobId));
    expect(job).toMatchObject({
      progress: { phase: "s3_originals", processedCount: 0 },
      status: "pending",
      type: "library_hard_wipe",
    });
    expect(processMaintenanceJob).toHaveBeenCalledWith(result.jobId);
    // The active-job guard, then the unique index, both say "already in progress".
    await expect(
      scheduleLibraryWipe({ confirmation: LIBRARY_WIPE_CONFIRMATION, syncToken: "t" }),
    ).rejects.toThrow("A cleanup job is already in progress.");
  });
});
