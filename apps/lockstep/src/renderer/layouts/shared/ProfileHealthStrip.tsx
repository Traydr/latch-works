import type { LockstepProfilePublic } from "../../../shared/types";

interface ProfileHealthStripProps {
  compact?: boolean;
  profile: LockstepProfilePublic;
}

export function ProfileHealthStrip({ compact = false, profile }: ProfileHealthStripProps) {
  const fields = [
    { label: "Source", value: profile.sourceRoot },
    { label: "API", value: profile.apiUrl },
    {
      label: "Token",
      value: profile.tokenConfigured
        ? profile.tokenInSession
          ? "In session"
          : "Stored"
        : profile.tokenUnreadable
          ? "Re-enter"
          : "Missing",
    },
    {
      label: "Last run",
      value: profile.lastRun
        ? `${profile.lastRun.action} · ${profile.lastRun.status}`
        : "None",
    },
  ];

  return (
    <div className={`grid gap-2 ${compact ? "grid-cols-2 sm:grid-cols-4" : "sm:grid-cols-2"}`}>
      {fields.map((field) => (
        <div
          key={field.label}
          className="min-w-0 rounded-lg border border-zinc-300/60 bg-white/50 px-2.5 py-2 dark:border-zinc-700/60 dark:bg-zinc-950/30"
        >
          <p className="text-[10px] font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
            {field.label}
          </p>
          <p className="truncate text-xs text-zinc-800 dark:text-zinc-100" title={field.value}>
            {field.value}
          </p>
        </div>
      ))}
    </div>
  );
}
