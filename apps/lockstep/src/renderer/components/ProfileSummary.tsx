import { Clock3, FolderOpen, KeyRound, Link2 } from "lucide-react";

import type { LockstepProfilePublic } from "../../shared/types";

interface ProfileSummaryProps {
  profile: LockstepProfilePublic;
}

function tokenStatusLabel(configured: boolean): string {
  return configured ? "Configured for this session" : "Not configured";
}

export function ProfileSummary({ profile }: ProfileSummaryProps) {
  const fields = [
    {
      icon: FolderOpen,
      label: "Source",
      value: profile.sourceRoot,
    },
    {
      icon: Link2,
      label: "Pane View API",
      value: profile.apiUrl,
    },
    {
      icon: KeyRound,
      label: "Sync token",
      value: tokenStatusLabel(profile.tokenConfigured),
    },
    {
      icon: Clock3,
      label: "Last run",
      value: profile.lastRun
        ? `${profile.lastRun.action} · ${profile.lastRun.status} · ${new Date(profile.lastRun.completedAt).toLocaleString()}`
        : "None",
    },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fields.map((field) => (
        <div
          key={field.label}
          className="rounded-xl border border-zinc-300/60 bg-white/50 px-3 py-2.5 dark:border-zinc-700/60 dark:bg-zinc-950/30"
        >
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
            <field.icon className="size-3.5" aria-hidden />
            {field.label}
          </div>
          <p className="truncate text-sm text-zinc-800 dark:text-zinc-100" title={field.value}>
            {field.value}
          </p>
        </div>
      ))}
    </div>
  );
}
