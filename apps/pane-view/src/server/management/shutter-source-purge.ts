import { and, isNull, not } from "drizzle-orm";
import { mediaObjects, shutterSourceCleanup } from "../db/schema";
import {
  type MaintenanceJobDescriptor,
  type MaintenanceTransaction,
  scheduleMaintenanceJob,
} from "./maintenance-scheduler";
import { liveShutterSourceCondition, orphanedShutterSourceCondition } from "./orphaned-sources";

/**
 * There is work when a queued source is unpurged and not live again, or an
 * orphaned media object's source is not queued yet.
 */
export async function hasPurgeableShutterSources(tx: MaintenanceTransaction): Promise<boolean> {
  const [queuedSource] = await tx
    .select({ sha256: shutterSourceCleanup.sha256 })
    .from(shutterSourceCleanup)
    .where(and(isNull(shutterSourceCleanup.purgedAt), not(liveShutterSourceCondition())))
    .limit(1);

  if (queuedSource) {
    return true;
  }

  const [eligibleSource] = await tx
    .select({ sha256: mediaObjects.sha256 })
    .from(mediaObjects)
    .where(orphanedShutterSourceCondition())
    .limit(1);

  return Boolean(eligibleSource);
}

export const shutterSourcePurgeDescriptor: MaintenanceJobDescriptor = {
  probe: hasPurgeableShutterSources,
  type: "shutter_source_purge",
};

export function scheduleShutterSourcePurge(): Promise<{
  jobId: string | null;
  phase: "empty" | "scheduled";
}> {
  return scheduleMaintenanceJob(shutterSourcePurgeDescriptor);
}
