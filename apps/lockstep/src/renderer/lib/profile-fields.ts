import type { LockstepProfilePublic } from "../../shared/types";

export interface ProfileField {
  label: string;
  value: string;
  tone?: string;
}

export function profileFieldList(profile: LockstepProfilePublic): ProfileField[] {
  const tokenStatus = profile.tokenConfigured
    ? profile.tokenInSession
      ? "In memory"
      : "Stored"
    : profile.tokenUnreadable
      ? "Unreadable"
      : "Not set";

  return [
    { label: "source", value: profile.sourceRoot },
    { label: "api", value: profile.apiUrl },
    {
      label: "token",
      value: tokenStatus,
      tone: profile.tokenConfigured ? "text-emerald-400" : "text-amber-400",
    },
    {
      label: "last run",
      value: profile.lastRun ? `${profile.lastRun.action} · ${profile.lastRun.status}` : "none",
    },
  ];
}
