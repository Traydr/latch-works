import type { LockstepPlanCounts, LockstepProfilePublic } from "../../shared/types";
import { formatAgo } from "./run-formatters";

export type ProfileTone = "error" | "warning" | "ok" | "neutral";

type RunAction = NonNullable<LockstepProfilePublic["lastRun"]>["action"];

const ACTION_NAME = {
  plan: "Plan",
  push: "Push",
  prune: "Prune",
  doctor: "Connection check",
} satisfies Record<RunAction, string>;

/** The one line the profile rail shows under a profile's name: what, if anything, to act on. */
export interface ProfileStatus {
  text: string;
  tone: ProfileTone;
}

function pendingChanges(counts: LockstepPlanCounts): number {
  return counts.upload + counts.update + counts.delete;
}

function describePending(counts: LockstepPlanCounts): ProfileStatus {
  const pending = pendingChanges(counts);

  return pending > 0
    ? { text: `${pending.toLocaleString()} to sync`, tone: "warning" }
    : { text: "In sync", tone: "ok" };
}

/**
 * `currentPlan` is the plan on screen, which is newer than anything saved on the profile; pass it
 * only for the active profile.
 */
export function profileStatus(
  profile: LockstepProfilePublic,
  currentPlan: LockstepPlanCounts | null,
): ProfileStatus {
  if (profile.tokenUnreadable) {
    return { text: "Token unreadable", tone: "error" };
  }

  if (!profile.tokenConfigured) {
    return { text: "No token saved", tone: "warning" };
  }

  if (currentPlan) {
    return describePending(currentPlan);
  }

  const lastRun = profile.lastRun;

  if (!lastRun) {
    return { text: "Never planned", tone: "neutral" };
  }

  if (lastRun.status === "failed") {
    return { text: `${ACTION_NAME[lastRun.action]} failed`, tone: "error" };
  }

  if (lastRun.status === "cancelled") {
    return { text: `${ACTION_NAME[lastRun.action]} cancelled`, tone: "neutral" };
  }

  switch (lastRun.action) {
    case "plan":
      return lastRun.planCounts
        ? describePending(lastRun.planCounts)
        : { text: "Planned", tone: "neutral" };
    case "push":
      return { text: `Pushed ${lastRun.pushed.toLocaleString()}`, tone: "ok" };
    case "prune":
      return { text: `Pruned ${lastRun.pushed.toLocaleString()}`, tone: "ok" };
    case "doctor":
      return { text: "Connection checked", tone: "ok" };
    default: {
      const _exhaustive: never = lastRun.action;

      return _exhaustive;
    }
  }
}

/** "Last push 18 ok, 0 failed · 2d ago" under the profile's name, or null before any run. */
export function describeLastRun(profile: LockstepProfilePublic, now: number): string | null {
  const lastRun = profile.lastRun;

  if (!lastRun) {
    return null;
  }

  const ago = formatAgo(Date.parse(lastRun.completedAt), now);

  const detail =
    lastRun.action === "push" || lastRun.action === "prune"
      ? `${lastRun.pushed.toLocaleString()} ok, ${lastRun.failed.toLocaleString()} failed`
      : lastRun.status;

  return `Last ${lastRun.action === "doctor" ? "check" : lastRun.action} ${detail} · ${ago}`;
}
