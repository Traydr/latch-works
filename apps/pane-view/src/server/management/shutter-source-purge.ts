import { and, isNull, not } from "drizzle-orm";
import { mediaObjects, shutterSourceCleanup } from "../db/schema";
import { SHUTTER_PURGE_INCOMPLETE_MESSAGE, shutterPurgeReadiness } from "../media/shutter-client";
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

export async function scheduleShutterSourcePurge(): Promise<{
  jobId: string | null;
  phase: "empty" | "scheduled";
}> {
  const readiness = shutterPurgeReadiness();

  if (readiness === "off") {
    throw new Error("Shutter is not configured, so there are no Shutter sources to purge.");
  }

  if (readiness === "incomplete") {
    throw new Error(SHUTTER_PURGE_INCOMPLETE_MESSAGE);
  }

  return scheduleMaintenanceJob(shutterSourcePurgeDescriptor);
}
