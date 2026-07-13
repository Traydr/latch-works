import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { maintenanceJobs } from "../db/schema";
import { processMaintenanceJob } from "./cleanup-worker";

export async function readActiveLegacyDerivativeCleanupJob(): Promise<{ id: string } | null> {
  const [job] = await db
    .select({ id: maintenanceJobs.id })
    .from(maintenanceJobs)
    .where(
      and(
        eq(maintenanceJobs.type, "legacy_derivative_cleanup"),
        inArray(maintenanceJobs.status, ["pending", "running"]),
      ),
    )
    .limit(1);
  return job ?? null;
}

export async function scheduleLegacyDerivativeCleanup({
  confirmation,
}: {
  confirmation: string;
}): Promise<{ jobId: string }> {
  if (confirmation !== "DELETE LEGACY DERIVATIVES") {
    throw new Error('Type "DELETE LEGACY DERIVATIVES" to confirm.');
  }

  const activeJob = await readActiveLegacyDerivativeCleanupJob();
  if (activeJob) {
    throw new Error("A legacy derivative cleanup is already running.");
  }

  const [job] = await db
    .insert(maintenanceJobs)
    .values({
      progress: {
        consecutiveNoProgressCount: 0,
        errorCount: 0,
        phase: "legacy_prefixes",
        prefix: "thumbnails/",
        processedBytes: 0,
        processedCount: 0,
      },
      status: "pending",
      type: "legacy_derivative_cleanup",
    })
    .returning({ id: maintenanceJobs.id });

  if (!job) throw new Error("Unable to schedule legacy derivative cleanup.");
  processMaintenanceJob(job.id);
  return { jobId: job.id };
}
