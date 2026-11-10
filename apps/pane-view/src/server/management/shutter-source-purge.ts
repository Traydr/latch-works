import { and, isNull, not } from "drizzle-orm";
import { mediaObjects, shutterSourceCleanup } from "../db/schema";
import { shutterConfig } from "../media/shutter-config";
import {
  type MaintenanceJobDescriptor,
  type MaintenanceTransaction,
  type ScheduleMaintenanceJobResult,
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

const shutterSourcePurgeDescriptor: MaintenanceJobDescriptor = {
  probe: hasPurgeableShutterSources,
  type: "shutter_source_purge",
};

export function scheduleShutterSourcePurge(): Promise<ScheduleMaintenanceJobResult> {
  if (shutterConfig.mode === "off") {
    throw new Error("Shutter is not configured, so there are no Shutter sources to purge.");
  }

  return scheduleMaintenanceJob(shutterSourcePurgeDescriptor);
}
