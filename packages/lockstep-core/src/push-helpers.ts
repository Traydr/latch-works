import path from "node:path";
import { escapesRoot } from "./scan.js";
import type { SyncPlanItem } from "./sync-plan.js";
import type { LockstepPlan } from "./types.js";

/** The bounded upload queue's width (plan 036). */
export const UPLOAD_CONCURRENCY = { default: 3, max: 8, min: 1 } as const;

export function resolveUploadConcurrency(value: number | undefined): number {
  if (value === undefined) {
    return UPLOAD_CONCURRENCY.default;
  }

  if (
    !Number.isInteger(value) ||
    value < UPLOAD_CONCURRENCY.min ||
    value > UPLOAD_CONCURRENCY.max
  ) {
    throw new RangeError(
      `uploadConcurrency must be an integer between ${UPLOAD_CONCURRENCY.min} and ${UPLOAD_CONCURRENCY.max}`,
    );
  }

  return value;
}

/** A capped slice of plan items plus the number the cap left behind. */
export interface CappedPlanItems<T> {
  items: T[];
  omittedCount: number;
}

function capped<T>(items: T[], maxChanges?: number): CappedPlanItems<T> {
  if (!maxChanges || items.length <= maxChanges) {
    return { items, omittedCount: 0 };
  }

  return { items: items.slice(0, maxChanges), omittedCount: items.length - maxChanges };
}

type PlanItems = Pick<LockstepPlan, "items">;

/** Every item of the plan that is not a keep, in plan order. */
export function plannedChanges(plan: PlanItems): SyncPlanItem[] {
  return plan.items.filter((item) => item.action !== "keep");
}

/** The uploads and updates `pushChanges` sends for `maxChanges`, in plan order. */
export function plannedUploads(
  plan: PlanItems,
  maxChanges?: number,
): CappedPlanItems<SyncPlanItem> {
  return capped(
    plan.items.filter((item) => item.action === "upload" || item.action === "update"),
    maxChanges,
  );
}

/** The deletes `pruneDeleted` applies for `maxChanges`, in plan order. */
export function plannedDeletes(
  plan: PlanItems,
  maxChanges?: number,
): CappedPlanItems<SyncPlanItem> {
  return capped(
    plan.items.filter((item) => item.action === "delete"),
    maxChanges,
  );
}

export function resolveLocalFilePath(sourceRoot: string, archivePath: string): string {
  const resolvedRoot = path.resolve(sourceRoot);
  const resolvedFile = path.resolve(resolvedRoot, ...archivePath.split("/"));
  const relative = path.relative(resolvedRoot, resolvedFile);

  if (escapesRoot(relative)) {
    throw new Error(`Local path escapes source root: ${archivePath}`);
  }

  return resolvedFile;
}
