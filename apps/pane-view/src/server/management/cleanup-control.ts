import { and, eq, inArray } from "drizzle-orm";
import { type Database, db } from "../db";
import { maintenanceJobs } from "../db/schema";

export async function cancelMaintenanceJob(
  { jobId }: { jobId: string },
  database: Database = db,
): Promise<{ cancelled: boolean }> {
  const [job] = await database
    .update(maintenanceJobs)
    .set({
      completedAt: new Date(),
      error: null,
      status: "cancelled",
    })
    .where(
      and(eq(maintenanceJobs.id, jobId), inArray(maintenanceJobs.status, ["pending", "running"])),
    )
    .returning({ id: maintenanceJobs.id });

  return { cancelled: Boolean(job) };
}
