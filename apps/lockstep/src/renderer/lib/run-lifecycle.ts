import type { LockstepPlan } from "../../shared/types";

export function shouldEndRunOnComplete(summaryAction: string, activeRunAction: string): boolean {
  if (summaryAction === "plan" && (activeRunAction === "push" || activeRunAction === "prune")) {
    return false;
  }

  return true;
}

export function isElapsedClockActive(
  running: boolean,
  startedAt: number | null,
  endedAt: number | null,
): boolean {
  return running || (startedAt != null && endedAt == null);
}

/** Whether Prune may run now, and if not, the reason its stage button shows. */
export type PruneAvailability =
  | { deleteCount: number; enabled: true }
  | { enabled: false; reason: string };

/**
 * Prune deletes exactly what the reviewed plan lists, once. It needs a plan with deletes whose
 * list has not been handed to Prune yet.
 */
export function pruneAvailability(
  plan: Pick<LockstepPlan, "counts" | "planId"> | null,
  prunedPlanId: string | null,
): PruneAvailability {
  if (!plan) {
    return {
      enabled: false,
      reason: "Run Plan first. Prune deletes only what a reviewed plan lists.",
    };
  }

  if (plan.planId === prunedPlanId) {
    return {
      enabled: false,
      reason: "This plan's deletes were already sent to Prune. Run Plan again to prune more.",
    };
  }

  if (plan.counts.delete === 0) {
    return { enabled: false, reason: "The reviewed plan has no remote deletes." };
  }

  return { deleteCount: plan.counts.delete, enabled: true };
}

export function describeRemoteEntries(count: number): string {
  return `${count} remote ${count === 1 ? "entry" : "entries"}`;
}
