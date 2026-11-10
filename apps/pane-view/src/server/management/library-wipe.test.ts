import { describe, expect, it } from "vitest";
import { maintenanceJobs } from "../db/schema";
import { testDatabaseForSuite } from "../library/test-db";
import { LIBRARY_WIPE_CONFIRMATION, scheduleLibraryWipe } from "./library-wipe";

/** A wipe is the one irreversible maintenance action; it must refuse before it touches a row. */
const testDatabase = testDatabaseForSuite();

describe("library wipe", () => {
  it("requires the confirmation string and the sync token before scheduling anything", async () => {
    const { db } = testDatabase();

    await expect(scheduleLibraryWipe({ confirmation: "wipe", syncToken: "t" }, db)).rejects.toThrow(
      `Type "${LIBRARY_WIPE_CONFIRMATION}" to confirm.`,
    );
    await expect(
      scheduleLibraryWipe({ confirmation: LIBRARY_WIPE_CONFIRMATION, syncToken: "t" }, db),
    ).rejects.toThrow("Invalid sync token.");
    expect(await db.select().from(maintenanceJobs)).toEqual([]);
  });
});
