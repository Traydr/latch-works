import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { maintenanceJobs } from "../db/schema";
import { listRunningSyncRuns } from "./sync-run-control";

export async function readActiveSyncRun(): Promise<{
  id: string;
  sourceRoot: string;
} | null> {
  const runningSyncRuns = await listRunningSyncRuns();
  const first = runningSyncRuns[0];
  if (!first) {
    return null;
  }

  return {
    id: first.id,
    sourceRoot: first.sourceRoot,
  };
}

export async function assertNoActiveSyncRun(): Promise<void> {
  const runningSyncRuns = await listRunningSyncRuns();
  if (runningSyncRuns.length === 0) {
    return;
  }

  if (runningSyncRuns.length === 1) {
    throw new Error(
      `A sync run is currently active (${runningSyncRuns[0]?.sourceRoot}). Stop it from sync run history or wait for it to finish before running maintenance.`,
    );
  }

  throw new Error(
    `${runningSyncRuns.length} sync runs are still marked running. Stop them from sync run history before running maintenance.`,
  );
}

export async function readActiveCleanupJob(): Promise<{
  id: string;
  phase: string;
  processedCount: number;
  errorCount: number;
  status: "pending" | "running";
} | null> {
  const [job] = await db
    .select({
      errorCount: sql<number>`(${maintenanceJobs.progress}->>'errorCount')::int`,
      id: maintenanceJobs.id,
      phase: sql<string>`${maintenanceJobs.progress}->>'phase'`,
      processedCount: sql<number>`(${maintenanceJobs.progress}->>'processedCount')::int`,
      status: maintenanceJobs.status,
    })
    .from(maintenanceJobs)
    .where(
      and(
        eq(maintenanceJobs.type, "library_hard_wipe"),
        inArray(maintenanceJobs.status, ["pending", "running"]),
      ),
    )
    .limit(1);

  if (!job || (job.status !== "pending" && job.status !== "running")) {
    return null;
  }

  return {
    errorCount: job.errorCount ?? 0,
    id: job.id,
    phase: job.phase ?? "s3_derivatives",
    processedCount: job.processedCount ?? 0,
    status: job.status,
  };
}

export async function assertNoActiveCleanupJob(): Promise<void> {
  const activeJob = await readActiveCleanupJob();
  if (activeJob) {
    throw new Error(
      "A library wipe cleanup job is still running. Wait for it to finish before starting a sync.",
    );
  }
}
