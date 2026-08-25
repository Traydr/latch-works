import { describe, expect, it, vi } from "vitest";
import { acquireLibraryMutationStartupLock } from "../db/library-coordination-lock";
import { maintenanceJobs } from "../db/schema";
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
});
