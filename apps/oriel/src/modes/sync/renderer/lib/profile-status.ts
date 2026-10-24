import type { LockstepPlanCounts, LockstepProfilePublic } from "../../shared/types";
import { formatAgo } from "./run-formatters";

export type ProfileTone = "error" | "warning" | "ok" | "neutral";

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
    ? { text: `${pending.toLocaleString()} pending`, tone: "warning" }
    : { text: "in sync", tone: "ok" };
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
    return { text: "token unreadable", tone: "error" };
  }

  if (!profile.tokenConfigured) {
    return { text: "token not set", tone: "warning" };
  }

  if (currentPlan) {
    return describePending(currentPlan);
  }

  const lastRun = profile.lastRun;

  if (!lastRun) {
    return { text: "never planned", tone: "neutral" };
  }

  if (lastRun.status === "failed") {
    return { text: `${lastRun.action} failed`, tone: "error" };
  }

  if (lastRun.status === "cancelled") {
    return { text: `${lastRun.action} cancelled`, tone: "neutral" };
  }

  switch (lastRun.action) {
    case "plan":
      return lastRun.planCounts
        ? describePending(lastRun.planCounts)
        : { text: "planned", tone: "neutral" };
    case "push":
      return { text: `pushed ${lastRun.pushed.toLocaleString()}`, tone: "ok" };
    case "prune":
      return { text: `pruned ${lastRun.pushed.toLocaleString()}`, tone: "ok" };
    case "doctor":
      return { text: "doctor passed", tone: "ok" };
    default: {
      const _exhaustive: never = lastRun.action;

      return _exhaustive;
    }
  }
}

/** "last push 18 ok · 0 failed · 2d ago" for the status bar, or null before any run. */
export function describeLastRun(profile: LockstepProfilePublic, now: number): string | null {
  const lastRun = profile.lastRun;

  if (!lastRun) {
    return null;
  }

  const ago = formatAgo(Date.parse(lastRun.completedAt), now);

  const detail =
    lastRun.action === "push" || lastRun.action === "prune"
      ? `${lastRun.pushed.toLocaleString()} ok · ${lastRun.failed.toLocaleString()} failed`
      : lastRun.status;

  return `last ${lastRun.action} ${detail} · ${ago}`;
}
