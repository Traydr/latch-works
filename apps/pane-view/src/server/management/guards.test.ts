import { describe, expect, it } from "vitest";

import { maintenanceJobs, syncRuns } from "../db/schema";
import { testDatabaseForSuite } from "../library/test-db";
import { assertNoActiveCleanupJob, assertNoActiveSyncRun } from "./guards";
import { initialProgressFor } from "./maintenance-progress";

const testDatabase = testDatabaseForSuite();

describe("management guards", () => {
  it("blocks destructive ops when a sync run is active", async () => {
    const { db } = testDatabase();
    await db.insert(syncRuns).values({ sourceRoot: "/archive", status: "running" });

    await expect(assertNoActiveSyncRun(db)).rejects.toThrow("sync run is currently active");

    await db.delete(syncRuns);
    await expect(assertNoActiveSyncRun(db)).resolves.toBeUndefined();
  });

  it("blocks sync starts when a cleanup job is active", async () => {
    const { db } = testDatabase();
    await db.insert(maintenanceJobs).values({
      progress: initialProgressFor("soft_deleted_purge"),
      status: "running",
      type: "soft_deleted_purge",
    });

    await expect(assertNoActiveCleanupJob(db)).rejects.toThrow("cleanup job is still running");

    await db.delete(maintenanceJobs);
    await expect(assertNoActiveCleanupJob(db)).resolves.toBeUndefined();
  });
});
