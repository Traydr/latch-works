import type { SyncRunStatus } from "@latch-works/sync-protocol";
import { z } from "zod";
import type { JsonValue } from "./json";

/**
 * The states of the library's long-running work, maintenance jobs and sync
 * runs, as the database enums, the worker, the schedulers and the management
 * screens all name them. Environment-neutral.
 *
 * Progress is the one way `maintenance_jobs.progress` (jsonb) enters the
 * worker or the status reader (Plan 049, Step 2). Each job type has its own
 * schema, so a phase valid for one type can never advance another, and only
 * the fields each type uses come through; unknown keys are ignored.
 */

export const SYNC_RUN_STATUSES = [
  "running",
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly ("running" | SyncRunStatus)[];

export type SyncRunState = (typeof SYNC_RUN_STATUSES)[number];

export const MAINTENANCE_JOB_TYPES = [
  "library_hard_wipe",
  "soft_deleted_purge",
  "shutter_source_purge",
] as const;

export type MaintenanceJobType = (typeof MAINTENANCE_JOB_TYPES)[number];

export const MAINTENANCE_JOB_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export type MaintenanceJobStatus = (typeof MAINTENANCE_JOB_STATUSES)[number];

/** A job in one of these states blocks syncs, library changes, and other jobs. */
export const ACTIVE_MAINTENANCE_JOB_STATUSES = [
  "pending",
  "running",
] as const satisfies readonly MaintenanceJobStatus[];

export type ActiveMaintenanceJobStatus = (typeof ACTIVE_MAINTENANCE_JOB_STATUSES)[number];

export function isActiveMaintenanceJobStatus(
  status: MaintenanceJobStatus,
): status is ActiveMaintenanceJobStatus {
  return ACTIVE_MAINTENANCE_JOB_STATUSES.some((active) => active === status);
}

const processedCountSchema = z
  .number()
  .int()
  .nonnegative({
    error: (issue) => `processedCount ${JSON.stringify(issue.input)} is not a non-negative integer`,
  });

function phaseSchema<const Phases extends readonly [string, ...string[]]>(
  type: MaintenanceJobType,
  phases: Phases,
) {
  return z.enum(phases, {
    error: (issue) => `phase ${JSON.stringify(issue.input)} is not valid for ${type}`,
  });
}

const LibraryWipeJobProgressSchema = z.object({
  phase: phaseSchema("library_hard_wipe", [
    "s3_originals",
    "s3_orphan_sweep",
    "db_hard_delete",
    "completed",
  ]),
  processedCount: processedCountSchema,
  /** The orphan sweep's listing cursor; anything else stored there is dropped. */
  orphanContinuationToken: z.string().nullable().catch(null),
});

export type LibraryWipeJobProgress = z.infer<typeof LibraryWipeJobProgressSchema>;

const SoftDeletedPurgeJobProgressSchema = z.object({
  phase: phaseSchema("soft_deleted_purge", ["orphaned_media", "db_hard_delete", "completed"]),
  processedCount: processedCountSchema,
});

export type SoftDeletedPurgeJobProgress = z.infer<typeof SoftDeletedPurgeJobProgressSchema>;

const ShutterSourcePurgeJobProgressSchema = z.object({
  phase: phaseSchema("shutter_source_purge", ["queue_sources", "shutter_sources", "completed"]),
  processedCount: processedCountSchema,
});

export type ShutterSourcePurgeJobProgress = z.infer<typeof ShutterSourcePurgeJobProgressSchema>;

const progressSchemas = {
  library_hard_wipe: LibraryWipeJobProgressSchema,
  soft_deleted_purge: SoftDeletedPurgeJobProgressSchema,
  shutter_source_purge: ShutterSourcePurgeJobProgressSchema,
} satisfies Record<MaintenanceJobType, z.ZodType>;

export type MaintenanceProgressFor<Type extends MaintenanceJobType> = z.infer<
  (typeof progressSchemas)[Type]
>;

export type MaintenanceJobProgress = MaintenanceProgressFor<MaintenanceJobType>;

export type ParsedMaintenanceProgress<Type extends MaintenanceJobType> =
  | { ok: true; progress: MaintenanceProgressFor<Type> }
  | { ok: false; reason: string };

/**
 * Parse stored progress for a job of `type`. The overload ties the result to
 * the caller's job type; the implementation looks the schema up in the map
 * the same enum keys.
 */
export function parseMaintenanceProgress<Type extends MaintenanceJobType>(
  type: Type,
  raw: JsonValue,
): ParsedMaintenanceProgress<Type>;
export function parseMaintenanceProgress(
  type: MaintenanceJobType,
  raw: JsonValue,
): ParsedMaintenanceProgress<MaintenanceJobType> {
  const result = progressSchemas[type].safeParse(raw);

  if (result.success) {
    return { ok: true, progress: result.data };
  }

  const first = result.error.issues[0];

  return { ok: false, reason: first ? describeIssue(first) : "progress does not fit its job type" };
}

function describeIssue(issue: z.core.$ZodIssue): string {
  if (issue.path.length === 0 && issue.code === "invalid_type") {
    return "progress is not an object";
  }

  return issue.message;
}

type InitialProgressByType = { [Type in MaintenanceJobType]: MaintenanceProgressFor<Type> };

/** The progress a freshly scheduled job of `type` starts with. */
export function initialProgressFor<Type extends MaintenanceJobType>(
  type: Type,
): MaintenanceProgressFor<Type> {
  const initial: InitialProgressByType = {
    library_hard_wipe: {
      orphanContinuationToken: null,
      phase: "s3_originals",
      processedCount: 0,
    },
    soft_deleted_purge: { phase: "orphaned_media", processedCount: 0 },
    shutter_source_purge: { phase: "queue_sources", processedCount: 0 },
  };

  return initial[type];
}
