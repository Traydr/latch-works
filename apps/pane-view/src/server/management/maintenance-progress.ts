import { z } from "zod";
import type { JsonValue } from "@/lib/json";

/**
 * The one way maintenance job progress enters the worker or the status
 * reader (Plan 049, Step 2). `maintenance_jobs.progress` is jsonb; nothing
 * else guarantees what it holds. Each job type has its own schema, so a phase
 * valid for one type can never advance another, and only the fields each
 * type actually uses come through. Unknown keys (such as the retired
 * errorCount/lastError) are ignored.
 */

export const MaintenanceJobTypeSchema = z.enum([
  "library_hard_wipe",
  "soft_deleted_purge",
  "shutter_source_purge",
]);
export type MaintenanceJobType = z.infer<typeof MaintenanceJobTypeSchema>;

/** The phase hard-wipe jobs carried before the Shutter-only architecture (migration 0010). */
const RETIRED_LIBRARY_WIPE_PHASE = "s3_derivatives";

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

/** An optional string carried by the orphan sweep; anything else stored there is dropped. */
const orphanCursorFieldSchema = z.string().nullable().catch(null);

export const LibraryWipeJobProgressSchema = z.object({
  phase: z
    .literal(RETIRED_LIBRARY_WIPE_PHASE)
    .transform(() => "s3_originals" as const)
    .or(
      phaseSchema("library_hard_wipe", [
        "s3_originals",
        "s3_orphan_sweep",
        "db_hard_delete",
        "completed",
      ]),
    ),
  processedCount: processedCountSchema,
  orphanPrefix: orphanCursorFieldSchema,
  orphanContinuationToken: orphanCursorFieldSchema,
});
export type LibraryWipeJobProgress = z.infer<typeof LibraryWipeJobProgressSchema>;

export const SoftDeletedPurgeJobProgressSchema = z.object({
  phase: phaseSchema("soft_deleted_purge", ["orphaned_media", "db_hard_delete", "completed"]),
  processedCount: processedCountSchema,
});
export type SoftDeletedPurgeJobProgress = z.infer<typeof SoftDeletedPurgeJobProgressSchema>;

export const ShutterSourcePurgeJobProgressSchema = z.object({
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
      orphanPrefix: null,
      phase: "s3_originals",
      processedCount: 0,
    },
    soft_deleted_purge: { phase: "orphaned_media", processedCount: 0 },
    shutter_source_purge: { phase: "queue_sources", processedCount: 0 },
  };
  return initial[type];
}
