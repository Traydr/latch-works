import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { maintenanceJobs, syncRuns } from "../db/schema";
import { listRunningSyncRuns } from "./sync-run-control";

type QueryClient = {
  select: typeof db.select;
};

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

export async function assertNoActiveSyncRun(client: QueryClient = db): Promise<void> {
  const runningSyncRuns = await client
    .select({
      id: syncRuns.id,
      sourceRoot: syncRuns.sourceRoot,
    })
    .from(syncRuns)
    .where(eq(syncRuns.status, "running"));

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

export async function readActiveCleanupJob(client: QueryClient = db): Promise<{
  id: string;
  phase: string;
  processedCount: number;
  errorCount: number;
  status: "pending" | "running";
} | null> {
  const [job] = await client
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
        inArray(maintenanceJobs.type, [
          "library_hard_wipe",
          "soft_deleted_purge",
          "shutter_source_purge",
        ]),
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
    phase: job.phase ?? "s3_originals",
    processedCount: job.processedCount ?? 0,
    status: job.status,
  };
}

export async function assertNoActiveCleanupJob(client: QueryClient = db): Promise<void> {
  const activeJob = await readActiveCleanupJob(client);
  if (activeJob) {
    throw new Error(
      "A library cleanup job is still running. Wait for it to finish before starting a sync.",
    );
  }
}
