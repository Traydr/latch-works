import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { maintenanceJobs } from "../db/schema";

export async function cancelMaintenanceJob({
  jobId,
}: {
  jobId: string;
}): Promise<{ cancelled: boolean }> {
  const [job] = await db
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
