import type {
  LibraryWipeJobProgress,
  MaintenanceJobProgress,
  ShutterSourcePurgeJobProgress,
  SoftDeletedPurgeJobProgress,
} from "../db/schema";

/**
 * The one way maintenance job progress enters the worker or the status
 * reader (Plan 049, Step 2). `maintenance_jobs.progress` is jsonb; nothing
 * else guarantees its shape. The parser validates the phase against the
 * job's own type, so a phase valid for one type can never advance another,
 * and passes through only the fields each type actually uses. Unknown keys
 * (such as the retired errorCount/lastError) are ignored.
 */

export type MaintenanceJobType =
  | "library_hard_wipe"
  | "soft_deleted_purge"
  | "shutter_source_purge";

const LIBRARY_WIPE_PHASES = new Set<LibraryWipeJobProgress["phase"]>([
  "s3_originals",
  "s3_orphan_sweep",
  "db_hard_delete",
  "completed",
]);
const SOFT_DELETED_PURGE_PHASES = new Set<SoftDeletedPurgeJobProgress["phase"]>([
  "orphaned_media",
  "db_hard_delete",
  "completed",
]);
const SHUTTER_SOURCE_PURGE_PHASES = new Set<ShutterSourcePurgeJobProgress["phase"]>([
  "queue_sources",
  "shutter_sources",
  "completed",
]);

/** The phase hard-wipe jobs carried before the Shutter-only architecture (migration 0010). */
const RETIRED_LIBRARY_WIPE_PHASE = "s3_derivatives";

export type ParsedMaintenanceProgress =
  | { ok: true; progress: MaintenanceJobProgress }
  | { ok: false; reason: string };

export function isMaintenanceJobType(value: unknown): value is MaintenanceJobType {
  return (
    value === "library_hard_wipe" ||
    value === "soft_deleted_purge" ||
    value === "shutter_source_purge"
  );
}

export function parseMaintenanceProgress(
  type: MaintenanceJobType,
  raw: unknown,
): ParsedMaintenanceProgress {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "progress is not an object" };
  }
  const record = raw as Record<string, unknown>;

  const processedCount = record.processedCount;
  if (
    typeof processedCount !== "number" ||
    !Number.isInteger(processedCount) ||
    processedCount < 0
  ) {
    return {
      ok: false,
      reason: `processedCount ${JSON.stringify(processedCount)} is not a non-negative integer`,
    };
  }

  const rawPhase = record.phase;
  if (typeof rawPhase !== "string") {
    return { ok: false, reason: `phase ${JSON.stringify(rawPhase)} is not a string` };
  }

  switch (type) {
    case "library_hard_wipe": {
      const phase = rawPhase === RETIRED_LIBRARY_WIPE_PHASE ? "s3_originals" : rawPhase;
      if (!isMember(LIBRARY_WIPE_PHASES, phase)) {
        return { ok: false, reason: `phase "${rawPhase}" is not valid for ${type}` };
      }
      const progress: LibraryWipeJobProgress = { phase, processedCount };
      if (typeof record.orphanPrefix === "string") {
        progress.orphanPrefix = record.orphanPrefix;
      }
      if (typeof record.orphanContinuationToken === "string") {
        progress.orphanContinuationToken = record.orphanContinuationToken;
      }
      return { ok: true, progress };
    }
    case "soft_deleted_purge": {
      if (!isMember(SOFT_DELETED_PURGE_PHASES, rawPhase)) {
        return { ok: false, reason: `phase "${rawPhase}" is not valid for ${type}` };
      }
      return { ok: true, progress: { phase: rawPhase, processedCount } };
    }
    case "shutter_source_purge": {
      if (!isMember(SHUTTER_SOURCE_PURGE_PHASES, rawPhase)) {
        return { ok: false, reason: `phase "${rawPhase}" is not valid for ${type}` };
      }
      return { ok: true, progress: { phase: rawPhase, processedCount } };
    }
  }
}

/** The progress a freshly scheduled job of `type` starts with. */
export function initialProgressFor(type: MaintenanceJobType): MaintenanceJobProgress {
  switch (type) {
    case "library_hard_wipe":
      return { phase: "s3_originals", processedCount: 0 };
    case "soft_deleted_purge":
      return { phase: "orphaned_media", processedCount: 0 };
    case "shutter_source_purge":
      return { phase: "queue_sources", processedCount: 0 };
  }
}

function isMember<T extends string>(set: ReadonlySet<T>, value: string): value is T {
  return (set as ReadonlySet<string>).has(value);
}
