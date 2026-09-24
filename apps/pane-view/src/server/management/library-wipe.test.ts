import { describe, expect, it, vi } from "vitest";
import { acquireLibraryMutationStartupLock } from "../db/library-coordination-lock";
import { libraryEntries, maintenanceJobs, mediaObjects } from "../db/schema";
import { testDatabaseForSuite } from "../library/test-db";
import { assertNoActiveSyncRun, readActiveCleanupJob } from "./guards";
import {
  LIBRARY_WIPE_CONFIRMATION,
  type LibraryWipeDependencies,
  scheduleLibraryWipe,
} from "./library-wipe";

/** A wipe is the one irreversible maintenance action; it must refuse before it touches a row. */
const testDatabase = testDatabaseForSuite();

const assertSyncApiToken = vi.fn();

const processMaintenanceJob = vi.fn();

function wipeDependencies(): LibraryWipeDependencies {
  return {
    assertSyncApiToken,
    scheduler: {
      acquireLibraryMutationStartupLock,
      assertNoActiveSyncRun,
      database: testDatabase().db,
      processMaintenanceJob,
      readActiveCleanupJob,
    },
    shutterPurgeReadiness: () => "ready",
  };
}

describe("library wipe", () => {
  it("requires the confirmation string and the sync token before scheduling anything", async () => {
    await expect(
      scheduleLibraryWipe({ confirmation: "wipe", syncToken: "t" }, wipeDependencies()),
    ).rejects.toThrow(`Type "${LIBRARY_WIPE_CONFIRMATION}" to confirm.`);
    expect(assertSyncApiToken).not.toHaveBeenCalled();

    assertSyncApiToken.mockImplementationOnce(() => {
      throw new Error("bad token");
    });
    await expect(
      scheduleLibraryWipe(
        { confirmation: LIBRARY_WIPE_CONFIRMATION, syncToken: "t" },
        wipeDependencies(),
      ),
    ).rejects.toThrow("bad token");
    expect(await testDatabase().db.select().from(maintenanceJobs)).toEqual([]);
    expect(processMaintenanceJob).not.toHaveBeenCalled();
  });

  it("refuses while Shutter is partly configured, before it touches a row", async () => {
    const { db } = testDatabase();

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

    await db.insert(libraryEntries).values({
      filename: "seed.jpg",
      logicalPath: "seed.jpg",
      mediaObjectId: object.id,
      mtimeMs: 1_700_000_000_000,
    });

    await expect(
      scheduleLibraryWipe(
        { confirmation: LIBRARY_WIPE_CONFIRMATION, syncToken: "t" },
        { ...wipeDependencies(), shutterPurgeReadiness: () => "incomplete" },
      ),
    ).rejects.toThrow("Shutter is partly configured");
    expect(await db.select().from(maintenanceJobs)).toEqual([]);
    expect(
      (await db.select({ deletedAt: libraryEntries.deletedAt }).from(libraryEntries)).map(
        (row) => row.deletedAt,
      ),
    ).toEqual([null]);
  });
});
