import { Plus, Settings as SettingsIcon } from "lucide-react";

import { useShell } from "../../../../shell/shell";
import { Spinner } from "../../../../ui/ui";
import type { LockstepPlanCounts, LockstepProfilePublic } from "../../shared/types";
import { type ProfileTone, profileStatus } from "../lib/profile-status";

const TONE_DOT = {
  error: "bg-red-500",
  warning: "bg-amber-500",
  ok: "bg-emerald-500",
  neutral: "bg-zinc-300 dark:bg-zinc-600",
} satisfies Record<ProfileTone, string>;

interface ProfileSidebarProps {
  profiles: LockstepProfilePublic[];
  activeProfileId: string | null;
  /** Counts of the plan on screen, which belongs to the active profile. */
  activePlanCounts: LockstepPlanCounts | null;
  /** A run is going: switching profile waits for it. */
  running: boolean;
  onSelect: (profileId: string) => void;
  onCreate: () => void;
}

/**
 * Sync's sidebar, as Tidy's lists its views: the profiles, each with the one line that says what
 * to act on, then Add profile and Settings at the foot. In rail form each profile is its initial.
 */
export function ProfileSidebar({
  profiles,
  activeProfileId,
  activePlanCounts,
  running,
  onSelect,
  onCreate,
}: ProfileSidebarProps) {
  const { rail, insetTitleBar, openSettings } = useShell();

  // The rail's buttons, as Tidy's: 48 px targets in the 88 px macOS rail, 40 px elsewhere.
  const railButton = `relative justify-center px-0 ${
    insetTitleBar ? "size-12 rounded-xl [&_svg]:size-[22px]" : "size-10 rounded-lg [&_svg]:size-5"
  }`;

  const list = rail ? "flex flex-col items-center space-y-1" : "space-y-0.5 px-2";

  return (
    <nav
      aria-label="Profiles"
      className={`flex min-h-0 w-full flex-1 flex-col ${rail ? "items-center" : ""}`}
    >
      {rail ? null : (
        <p className="px-[18px] pt-3 pb-1.5 text-xs font-medium text-zinc-500">Profiles</p>
      )}
      <ul className={`min-h-0 overflow-y-auto ${list}`}>
        {profiles.map((profile) => {
          const active = profile.id === activeProfileId;
          const status = profileStatus(profile, active ? activePlanCounts : null);
          const working = active && running;
          const caption = working ? "Running…" : status.text;

          return (
            <li key={profile.id}>
              <button
                type="button"
                className={`lw-sidebar-item ${rail ? railButton : "h-auto min-h-8 py-1.5"}`}
                aria-current={active ? "true" : undefined}
                aria-label={rail ? profile.name : undefined}
                title={rail ? `${profile.name} · ${caption}` : undefined}
                disabled={running && !active}
                onClick={() => onSelect(profile.id)}
              >
                {rail ? (
                  <>
                    <span className="flex size-7 items-center justify-center rounded-lg bg-white text-[13px] font-semibold text-zinc-700 shadow-[var(--shadow-border)] dark:bg-white/[0.08] dark:text-zinc-200">
                      {profile.name.trim().charAt(0).toUpperCase() || "?"}
                    </span>
                    <span
                      className={`absolute top-1.5 right-1.5 size-1.5 rounded-full ${TONE_DOT[status.tone]}`}
                      aria-hidden
                    />
                  </>
                ) : (
                  <>
                    <span
                      className={`size-2 shrink-0 rounded-full ${TONE_DOT[status.tone]}`}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{profile.name}</span>
                      <span className="lw-caption block truncate">{caption}</span>
                    </span>
                    {working ? <Spinner /> : null}
                  </>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      <ul className={`mt-auto pt-1 pb-3 ${list}`}>
        <li>
          <button
            type="button"
            className={`lw-sidebar-item ${rail ? railButton : ""}`}
            title="Add profile"
            aria-label={rail ? "Add profile" : undefined}
            onClick={onCreate}
          >
            <Plus />
            {rail ? null : <span className="min-w-0 flex-1 truncate">Add profile</span>}
          </button>
        </li>
        <li>
          <button
            type="button"
            className={`lw-sidebar-item ${rail ? railButton : ""}`}
            title="Settings  ⌘,"
            aria-label={rail ? "Settings" : undefined}
            onClick={() => openSettings("sync")}
          >
            <SettingsIcon />
            {rail ? null : <span className="min-w-0 flex-1 truncate">Settings</span>}
          </button>
        </li>
      </ul>
    </nav>
  );
}
