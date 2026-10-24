import { MoreHorizontal, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { LockstepPlanCounts, LockstepProfilePublic } from "../../shared/types";
import { type ProfileTone, profileStatus } from "../lib/profile-status";
import { Spinner } from "./syncPrimitives";

const TONE_DOT = {
  error: "bg-red-500",
  warning: "bg-amber-500",
  ok: "bg-emerald-500",
  neutral: "bg-zinc-400 dark:bg-zinc-600",
} satisfies Record<ProfileTone, string>;

const TONE_TEXT = {
  error: "text-red-600 dark:text-red-300",
  warning: "text-zinc-500",
  ok: "text-zinc-500",
  neutral: "text-zinc-500",
} satisfies Record<ProfileTone, string>;

interface ProfileRailProps {
  profiles: LockstepProfilePublic[];
  activeProfileId: string | null;
  /** Counts of the plan on screen, which belongs to the active profile. */
  activePlanCounts: LockstepPlanCounts | null;
  /** A run is going: the selection and profile edits wait for it. */
  running: boolean;
  onSelect: (profileId: string) => void;
  onCreate: () => void;
  onEdit: (profileId: string) => void;
  onDoctor: () => void;
  onDelete: (profileId: string) => void;
}

export function ProfileRail({
  profiles,
  activeProfileId,
  activePlanCounts,
  running,
  onSelect,
  onCreate,
  onEdit,
  onDoctor,
  onDelete,
}: ProfileRailProps) {
  return (
    <nav
      aria-label="Profiles"
      className="flex w-48 shrink-0 flex-col gap-0.5 border-r border-zinc-200 bg-zinc-50 px-2 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/60"
    >
      <div className="flex items-center px-1.5 pb-1.5">
        <span className="ls-label">Profiles</span>
        <button
          type="button"
          className="ls-btn ls-btn-ghost ml-auto h-5 px-1"
          onClick={onCreate}
          title="Add profile"
        >
          <Plus className="size-3" aria-hidden />
        </button>
      </div>
      {profiles.map((profile) => {
        const active = profile.id === activeProfileId;
        const status = profileStatus(profile, active ? activePlanCounts : null);

        return (
          <div key={profile.id} className="group relative">
            <button
              type="button"
              aria-current={active ? "true" : undefined}
              disabled={running && !active}
              onClick={() => onSelect(profile.id)}
              className={`w-full rounded-md py-1.5 pr-7 pl-2 text-left transition disabled:opacity-50 ${active ? "bg-violet-500/10 shadow-[inset_2px_0_0_var(--color-violet-500)]" : "hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60"}`}
            >
              <span
                className={`block truncate text-xs ${active ? "font-medium text-zinc-900 dark:text-zinc-100" : "text-zinc-700 dark:text-zinc-300"}`}
              >
                {profile.name}
              </span>
              <span
                className={`mt-0.5 block truncate ls-mono text-[10px] ${active && running ? "text-violet-600 dark:text-violet-300" : TONE_TEXT[status.tone]}`}
              >
                {active && running ? "running…" : status.text}
              </span>
            </button>
            <span className="pointer-events-none absolute top-2.5 right-2">
              {active && running ? (
                <Spinner />
              ) : (
                <span
                  className={`block size-1.5 rounded-full ${TONE_DOT[status.tone]} ${active ? "group-hover:opacity-0" : ""}`}
                />
              )}
            </span>
            {active && !running ? (
              <ProfileMenu
                onEdit={() => onEdit(profile.id)}
                onDoctor={onDoctor}
                onDelete={() => onDelete(profile.id)}
              />
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}

function ProfileMenu({
  onEdit,
  onDoctor,
  onDelete,
}: {
  onEdit: () => void;
  onDoctor: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target;

      if (!(target instanceof Node) || !rootRef.current?.contains(target)) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);

    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div ref={rootRef} className="absolute top-1 right-1">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        title="Profile actions"
        onClick={() => setOpen((current) => !current)}
        className={`ls-btn ls-btn-ghost h-5 px-0.5 ${open ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}`}
      >
        <MoreHorizontal className="size-3.5" aria-hidden />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute top-full right-0 z-50 mt-1 w-36 rounded-lg border border-zinc-200 bg-white p-1 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
        >
          <MenuItem label="Edit profile" onClick={choose(onEdit)} />
          <MenuItem label="Run doctor" onClick={choose(onDoctor)} />
          <MenuItem label="Delete profile" danger onClick={choose(onDelete)} />
        </div>
      ) : null}
    </div>
  );
}

function MenuItem({
  label,
  danger = false,
  onClick,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`block w-full rounded-md px-2 py-1 text-left text-xs ${danger ? "text-red-600 hover:bg-red-500/10 dark:text-red-300" : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"}`}
    >
      {label}
    </button>
  );
}
