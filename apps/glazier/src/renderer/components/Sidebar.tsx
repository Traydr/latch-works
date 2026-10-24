import type { Job, Root, Tidy } from "@latch-works/glazier-core/contract";
import {
  Archive,
  ChevronsUpDown,
  CircleAlert,
  Copy,
  FolderOpen,
  History,
  LayoutGrid,
  Library,
  Pause,
  Play,
  Repeat2,
  Settings as SettingsIcon,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { type ComponentType, createContext, useContext, useState } from "react";

import { useActions } from "../lib/actions";
import { call, desktop } from "../lib/api";
import { useEngine, useEngineQuery } from "../lib/engine-state";
import { formatBytes, formatCount, plural } from "../lib/format";
import { useNavigation, type View } from "../lib/navigation";
import { ProgressBar, Spinner } from "./ui";

/** The files Convert would change, without the extension fixes Clean up makes. */
function convertCount(tidy: Tidy): number {
  return tidy.convert.categories
    .filter((category) => !category.category.startsWith("rename-"))
    .reduce((sum, category) => sum + category.files, 0);
}

/** Everything Clean up would do: silent soundtracks, junk, empty folders and wrong extensions. */
export function cleanupCount(tidy: Tidy): number {
  return (
    tidy.silentTracks.files +
    tidy.cleanup.junk +
    tidy.cleanup.emptyFolders +
    tidy.cleanup.extensions
  );
}

/**
 * Forgets a root after a native sheet that says what forgetting loses. Its held files live in
 * Glazier's own storage, where nothing would find them once the root is gone, so they go to the
 * Trash first; if any cannot, the root stays.
 */
async function forgetRoot(root: Root, report: (cause: unknown) => void): Promise<void> {
  const confirmed = await desktop.confirm({
    message: `Forget “${root.name}”?`,
    detail:
      "Glazier forgets this folder's catalog and undo history, and moves what it holds for this folder to the Trash. The folder itself is not touched.",
    confirmLabel: "Forget",
    destructive: true,
  });

  if (!confirmed) {
    return;
  }

  try {
    const { failed } = await desktop.emptyHolding(root.id);

    if (failed.length > 0) {
      throw new Error(`Kept “${root.name}”: some held files could not go to the Trash.`);
    }

    await call("removeRoot", { rootId: root.id });
  } catch (error) {
    report(error);
  }
}

/** Whether the sidebar is the narrow rail of icons, under 1180 px or when ⌘\\ chose it. */
const RailContext = createContext(false);

/**
 * The rail's buttons. On macOS the rail is 88 px to hold the window buttons, which leaves room
 * for 48 px targets with 22 px icons; elsewhere it is 56 px, with 40 px targets.
 */
const RAIL_BUTTON = desktop.insetTitleBar() ? "size-12 rounded-xl" : "size-10 rounded-lg";

const RAIL_ICON = desktop.insetTitleBar() ? "[&_svg]:size-[22px]" : "[&_svg]:size-5";

function NavItem({
  view,
  label,
  icon: Icon,
  count,
  shortcut,
}: {
  view: View;
  label: string;
  icon: ComponentType<{ className?: string }>;
  count?: string | null;
  shortcut: string;
}) {
  const navigation = useNavigation();
  const rail = useContext(RailContext);

  if (rail) {
    return (
      <li>
        <button
          type="button"
          className={`gz-sidebar-item relative justify-center px-0 ${RAIL_BUTTON} ${RAIL_ICON}`}
          aria-current={navigation.view === view ? "page" : undefined}
          aria-label={label}
          data-view={view}
          title={`${label}${count ? ` · ${count}` : ""}  ${shortcut}`}
          onClick={() => navigation.go(view)}
        >
          <Icon />
          {count ? (
            <span
              className="absolute top-2 right-2 size-1.5 rounded-full bg-zinc-400"
              data-badge={view}
            />
          ) : null}
        </button>
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        className="gz-sidebar-item"
        aria-current={navigation.view === view ? "page" : undefined}
        data-view={view}
        title={`${label}  ${shortcut}`}
        onClick={() => navigation.go(view)}
      >
        <Icon />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count ? (
          <span className="gz-sidebar-count" data-badge={view}>
            {count}
          </span>
        ) : null}
      </button>
    </li>
  );
}

function GroupLabel({ children }: { children: string }) {
  const rail = useContext(RailContext);

  return rail ? (
    <li className="mx-auto my-3 h-px w-8 bg-zinc-200 dark:bg-white/[0.08]" aria-hidden />
  ) : (
    <li className="px-2.5 pt-5 pb-1.5 text-xs font-medium text-zinc-500">{children}</li>
  );
}

export function Sidebar({ onAddRoot, rail }: { onAddRoot: () => void; rail: boolean }) {
  const { roots, rootId, selectRoot, report } = useEngine();
  const root = roots.find((candidate) => candidate.id === rootId) ?? null;
  const tidy = useEngineQuery("tidy", rootId === null ? null : { rootId });

  const holding = useEngineQuery(
    "listHolding",
    rootId === null ? null : { rootId, offset: 0, limit: 1 },
  );

  const counted = (count: number | undefined) =>
    count === undefined || count === 0 ? null : formatCount(count);

  const chooseRoot = async () => {
    if (!root) {
      return;
    }

    const choice = await desktop.showMenu([
      ...roots.map((candidate) => ({
        type: "item" as const,
        id: `root:${candidate.id}`,
        label: candidate.name,
        sublabel: candidate.path,
        checked: candidate.id === root.id,
      })),
      { type: "separator" },
      { type: "item", id: "add", label: "Add Folder…", accelerator: "CmdOrCtrl+O" },
      { type: "item", id: "rescan", label: "Rescan", accelerator: "CmdOrCtrl+R" },
      { type: "item", id: "reveal", label: "Show in Finder" },
      { type: "separator" },
      { type: "item", id: "forget", label: `Forget “${root.name}”…` },
    ]);

    if (choice?.startsWith("root:")) {
      const chosen = roots.find((candidate) => `root:${candidate.id}` === choice);

      if (chosen) {
        selectRoot(chosen.id);
      }

      return;
    }

    switch (choice) {
      case "add":
        onAddRoot();
        break;
      case "rescan":
        await call("scanRoot", { rootId: root.id }).catch(report);
        break;
      case "reveal":
        await desktop.reveal(root.path);
        break;
      case "forget":
        await forgetRoot(root, report);
        break;
      default:
        break;
    }
  };

  return (
    <RailContext.Provider value={rail}>
      <nav
        aria-label="Glazier"
        className={`flex shrink-0 flex-col border-r gz-divider bg-zinc-50 dark:bg-zinc-900/60 ${
          // On macOS the window buttons sit in the rail's top strip; at 16 px in they end near
          // 76 px, so the rail is wide enough to hold them rather than spill over the top bar.
          rail ? (desktop.insetTitleBar() ? "w-[88px] items-center" : "w-14 items-center") : "w-60"
        }`}
      >
        <div className="gz-drag h-[52px] w-full shrink-0" />

        {root && rail ? (
          <button
            type="button"
            onClick={() => void chooseRoot()}
            title={`${root.name}\n${root.path}`}
            aria-label={root.name}
            data-root-switcher
            className={`flex items-center justify-center hover:bg-zinc-900/[0.05] dark:hover:bg-white/[0.05] ${RAIL_BUTTON}`}
          >
            <span className="flex size-9 items-center justify-center rounded-lg bg-white text-zinc-600 shadow-[var(--shadow-border)] dark:bg-white/[0.08] dark:text-zinc-300">
              <FolderOpen className="size-[18px]" />
            </span>
          </button>
        ) : root ? (
          <div className="px-2">
            <button
              type="button"
              onClick={() => void chooseRoot()}
              title={root.path}
              data-root-switcher
              className="flex h-[52px] w-full items-center gap-2.5 rounded-lg px-2 text-left hover:bg-zinc-900/[0.05] dark:hover:bg-white/[0.05]"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white text-zinc-600 shadow-[var(--shadow-border)] dark:bg-white/[0.08] dark:text-zinc-300">
                <FolderOpen className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold">{root.name}</span>
                <span className="gz-caption block truncate">
                  {plural(root.fileCount, "file")} · {formatBytes(root.totalBytes)}
                </span>
              </span>
              <ChevronsUpDown className="size-3.5 shrink-0 text-zinc-400" />
            </button>
          </div>
        ) : null}

        <ul
          className={`overflow-y-auto pt-3 ${rail ? "flex flex-col items-center space-y-1" : "space-y-0.5 px-2"}`}
        >
          <NavItem view="overview" label="Overview" icon={LayoutGrid} shortcut="⌘1" />
          <GroupLabel>Tidy</GroupLabel>
          <NavItem
            view="duplicates"
            label="Duplicates"
            icon={Copy}
            shortcut="⌘2"
            // Only the sets that need eyes: Tidy up takes care of identical copies.
            count={counted(tidy.data?.duplicates.similar.sets)}
          />
          <NavItem
            view="convert"
            label="Convert"
            icon={Repeat2}
            shortcut="⌘3"
            count={counted(tidy.data ? convertCount(tidy.data) : undefined)}
          />
          <NavItem
            view="cleanup"
            label="Clean up"
            icon={Sparkles}
            shortcut="⌘4"
            count={counted(tidy.data ? cleanupCount(tidy.data) : undefined)}
          />
          <GroupLabel>Archive</GroupLabel>
          <NavItem view="library" label="Library" icon={Library} shortcut="⌘5" />
          <NavItem view="history" label="History" icon={History} shortcut="⌘6" />
        </ul>

        <div
          className={`mt-auto pb-3 ${rail ? "flex flex-col items-center space-y-1" : "space-y-0.5 px-2"}`}
        >
          <Activity />
          <ul className={`pt-1 ${rail ? "flex flex-col items-center space-y-1" : "space-y-0.5"}`}>
            <NavItem
              view="holding"
              label="Holding"
              icon={Archive}
              shortcut="⌘7"
              count={
                holding.data && holding.data.total > 0 ? formatBytes(holding.data.totalBytes) : null
              }
            />
            <NavItem view="settings" label="Settings" icon={SettingsIcon} shortcut="⌘," />
          </ul>
        </div>
      </nav>
    </RailContext.Provider>
  );
}

function isActive(job: Job): boolean {
  return job.state === "queued" || job.state === "running" || job.state === "paused";
}

/**
 * The job that is running, with its progress, Pause and Stop; background analysis shows the same
 * way, in grey. A failed scan or analysis stays until it is dismissed. Nothing shows when idle.
 */
function Activity() {
  const { jobs, report } = useEngine();
  const { view } = useNavigation();
  const actions = useActions();
  const rail = useContext(RailContext);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const active = jobs.filter(isActive);

  const current =
    active.find((job) => job.state === "running" || job.state === "paused") ?? active[0] ?? null;

  const queued = active.length - (current ? 1 : 0);

  // Failed plans report through their toast; a failed scan or analysis has no other place.
  const failed = jobs.find(
    (job) =>
      job.state === "failed" &&
      job.type !== "apply" &&
      job.type !== "undo" &&
      jobs.find((other) => other.type === job.type && other.rootId === job.rootId) === job,
  );

  // The screen that started a job shows its own progress, so the card waits until the owner
  // leaves it.
  const shownByView = current !== null && actions.sourceOf(current.id)?.split(":")[0] === view;

  if (current && shownByView) {
    return (
      <div
        data-testid="activity"
        data-job-type={current.type}
        data-job-state={current.state}
        hidden
      />
    );
  }

  if (current && rail) {
    return (
      <div
        className={`flex items-center justify-center ${RAIL_BUTTON}`}
        title={`${current.label}${current.total > 0 ? ` · ${formatCount(current.done)} of ${formatCount(current.total)}` : ""}`}
        data-testid="activity"
        data-job-type={current.type}
        data-job-state={current.state}
      >
        {current.state === "paused" ? <Pause className="size-4 text-zinc-500" /> : <Spinner />}
      </div>
    );
  }

  if (current) {
    const ratio = current.total > 0 ? current.done / current.total : null;
    const paused = current.state === "paused";

    return (
      <div
        className="gz-card gz-enter-rise mb-2 p-3"
        data-testid="activity"
        data-job-type={current.type}
        data-job-state={current.state}
      >
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{current.label}</span>
          {current.total > 0 ? (
            <span className="gz-caption shrink-0">
              {formatCount(current.done)} of {formatCount(current.total)}
            </span>
          ) : null}
        </div>
        <ProgressBar ratio={ratio} muted={current.background} className="mt-2" />
        <div className="mt-1.5 flex items-center gap-1">
          <span className="gz-caption min-w-0 flex-1 truncate">
            {paused
              ? "Paused"
              : current.message && current.message !== current.label
                ? current.message
                : queued > 0
                  ? `${queued} more queued`
                  : current.background
                    ? "In the background"
                    : "Working…"}
          </span>
          {current.state === "running" || paused ? (
            <button
              type="button"
              className="gz-btn gz-btn-ghost gz-btn-icon-sm"
              aria-label={paused ? "Resume" : "Pause"}
              title={paused ? "Resume" : "Pause"}
              onClick={() =>
                void call("pauseJob", { jobId: current.id, paused: !paused }).catch(report)
              }
            >
              {paused ? <Play /> : <Pause />}
            </button>
          ) : null}
          <button
            type="button"
            className="gz-btn gz-btn-ghost gz-btn-icon-sm"
            aria-label="Stop"
            title="Stop (finished steps stay done and can be undone)"
            onClick={() => void call("cancelJob", { jobId: current.id }).catch(report)}
          >
            <Square className="size-3 fill-current" />
          </button>
        </div>
      </div>
    );
  }

  if (failed && failed.id !== dismissed && rail) {
    return (
      <button
        type="button"
        className={`gz-btn gz-btn-ghost gz-btn-icon text-red-600 dark:text-red-400 ${RAIL_BUTTON} ${RAIL_ICON}`}
        title={`${failed.label} failed: ${failed.message ?? ""}  (click to dismiss)`}
        aria-label={`${failed.label} failed`}
        data-testid="activity"
        onClick={() => setDismissed(failed.id)}
      >
        <CircleAlert />
      </button>
    );
  }

  if (failed && failed.id !== dismissed) {
    return (
      <div
        className="mb-2 rounded-xl bg-red-500/10 p-3 text-red-700 dark:text-red-300"
        data-testid="activity"
      >
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-[13px]">
            <span className="font-medium">{failed.label} failed.</span>{" "}
            <span className="opacity-80">{failed.message}</span>
          </p>
          <button
            type="button"
            className="gz-btn gz-btn-ghost gz-btn-icon-sm -mt-1 -mr-1"
            aria-label="Dismiss"
            onClick={() => setDismissed(failed.id)}
          >
            <X />
          </button>
        </div>
      </div>
    );
  }

  return <div data-testid="activity" hidden />;
}
