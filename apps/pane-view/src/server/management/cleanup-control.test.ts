import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { maintenanceJobs } from "../db/schema";
import { testDatabaseForSuite } from "../library/test-db";
import { cancelMaintenanceJob } from "./cleanup-control";
import { initialProgressFor } from "./maintenance-progress";

const testDatabase = testDatabaseForSuite();

async function insertJob(status: "running" | "completed"): Promise<string> {
  const { db } = testDatabase();
  const [job] = await db
    .insert(maintenanceJobs)
    .values({
      progress: initialProgressFor("soft_deleted_purge"),
      status,
      type: "soft_deleted_purge",
    })
    .returning({ id: maintenanceJobs.id });
  if (!job) throw new Error("failed to insert maintenance job");
  return job.id;
}

describe("cancelMaintenanceJob", () => {
  it("durably cancels an active cleanup job", async () => {
    const { db } = testDatabase();
    const jobId = await insertJob("running");

    await expect(cancelMaintenanceJob({ jobId }, db)).resolves.toEqual({ cancelled: true });

    const [job] = await db.select().from(maintenanceJobs).where(eq(maintenanceJobs.id, jobId));
    expect(job?.status).toBe("cancelled");
    expect(job?.error).toBeNull();
    expect(job?.completedAt).toBeInstanceOf(Date);

    await db.delete(maintenanceJobs);
  });

  it("does not change a terminal or missing job", async () => {
    const { db } = testDatabase();
    const jobId = await insertJob("completed");

    await expect(cancelMaintenanceJob({ jobId }, db)).resolves.toEqual({ cancelled: false });
    await expect(
      cancelMaintenanceJob({ jobId: "00000000-0000-4000-8000-000000000001" }, db),
    ).resolves.toEqual({ cancelled: false });

    const [job] = await db.select().from(maintenanceJobs).where(eq(maintenanceJobs.id, jobId));
    expect(job?.status).toBe("completed");

    await db.delete(maintenanceJobs);
  });
});
