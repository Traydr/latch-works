import { Footprints, Plus } from "lucide-react";

import type { LockstepSettings } from "../../shared/types";

interface AppHeaderProps {
  onAddProfile: () => void;
  onProfileChange: (profileId: string) => void;
  settings: LockstepSettings | null;
}

export function AppHeader({ onAddProfile, onProfileChange, settings }: AppHeaderProps) {
  return (
    <header className="prism-surface flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-violet-300/70 bg-violet-100/80 text-violet-700 dark:border-violet-500/40 dark:bg-violet-500/15 dark:text-violet-200">
          <Footprints className="size-4" aria-hidden />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-tight">Lockstep</p>
          <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            Sync local archive to Pane View
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {settings && settings.profiles.length > 0 ? (
          <select
            className="prism-select max-w-[12rem]"
            value={settings.activeProfileId ?? ""}
            onChange={(event) => onProfileChange(event.target.value)}
            aria-label="Active profile"
          >
            {settings.profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        ) : null}
        <button className="prism-btn inline-flex items-center gap-1.5" type="button" onClick={onAddProfile}>
          <Plus className="size-3.5" aria-hidden />
          {settings?.profiles.length ? "Add profile" : "Create profile"}
        </button>
      </div>
    </header>
  );
}
