import type { LockstepPlan } from "../../shared/types";

export function shouldEndRunOnComplete(summaryAction: string, activeRunAction: string): boolean {
  if (summaryAction === "plan" && (activeRunAction === "push" || activeRunAction === "prune")) {
    return false;
  }

  return true;
}

/** Whether Prune may run now, and if not, the reason its stage button shows. */
export type PruneAvailability =
  | { deleteCount: number; enabled: true }
  | { enabled: false; reason: string };

/**
 * Prune deletes exactly what the reviewed plan lists, once. It needs a plan with deletes whose
 * list has not been handed to Prune yet, and waits for that plan's push when it has one: a moved
 * file is a delete plus an upload, and the old path should only go once the new one has landed.
 */
export function pruneAvailability({
  plan,
  prunedPlanId,
  pushCompleted,
}: {
  plan: Pick<LockstepPlan, "counts" | "planId"> | null;
  prunedPlanId: string | null;
  pushCompleted: boolean;
}): PruneAvailability {
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

  if (plan.counts.upload + plan.counts.update > 0 && !pushCompleted) {
    return {
      enabled: false,
      reason: "Push this plan's uploads and updates first; Prune unlocks when the push completes.",
    };
  }

  return { deleteCount: plan.counts.delete, enabled: true };
}

export function describeRemoteEntries(count: number): string {
  return `${count} remote ${count === 1 ? "entry" : "entries"}`;
}
