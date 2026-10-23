import type { RootId } from "@latch-works/glazier-core/contract";
import {
  BookOpen,
  Copy,
  FolderPlus,
  Gauge,
  Inbox,
  Library,
  RefreshCw,
  Settings as SettingsIcon,
  Sparkles,
  Trash2,
  Volume2,
} from "lucide-react";
import type { ComponentType } from "react";

import glazierIcon from "../../media/glazier-icon.svg";
import { JobBar } from "./components/JobBar";
import { PlanProvider } from "./components/PlanDialog";
import { EmptyState } from "./components/ui";
import { call, desktop } from "./lib/api";
import { EngineProvider, useActiveJob, useEngine } from "./lib/engine-state";
import { formatBytes, formatCount, formatRelative } from "./lib/format";
import { NavigationProvider, useNavigation, type View } from "./lib/navigation";
import { useSystemTheme } from "./lib/use-system-theme";
import { DuplicatesView } from "./views/DuplicatesView";
import { HoldingView } from "./views/HoldingView";
import { JournalView } from "./views/JournalView";
import { LibraryView } from "./views/LibraryView";
import { OptimizeView } from "./views/OptimizeView";
import { OverviewView } from "./views/OverviewView";
import { SettingsView } from "./views/SettingsView";
import { SoundView } from "./views/SoundView";

const NAV: ReadonlyArray<{
  view: View;
  label: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  { view: "overview", label: "Overview", icon: Gauge },
  { view: "library", label: "Library", icon: Library },
  { view: "duplicates", label: "Duplicates", icon: Copy },
  { view: "optimize", label: "Optimize", icon: Sparkles },
  { view: "sound", label: "Sound", icon: Volume2 },
  { view: "holding", label: "Holding", icon: Inbox },
  { view: "journal", label: "Journal", icon: BookOpen },
  { view: "settings", label: "Settings", icon: SettingsIcon },
];

export function App() {
  useSystemTheme();

  return (
    <EngineProvider>
      <NavigationProvider>
        <PlanProvider>
          <Shell />
        </PlanProvider>
      </NavigationProvider>
    </EngineProvider>
  );
}

function Shell() {
  const { ready, roots, rootId, error, dismissError } = useEngine();
  const root = roots.find((candidate) => candidate.id === rootId) ?? null;
  const scan = useActiveJob("scan", rootId);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-white text-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="flex h-[30px] shrink-0 items-center gap-2 border-b ls-divider bg-zinc-50 px-3 dark:bg-zinc-900/60">
        <img src={glazierIcon} className="size-3.5 shrink-0" alt="" />
        <span className="text-xs font-semibold tracking-tight">Glazier</span>
        {root ? (
          <>
            <span className="text-xs text-zinc-400 dark:text-zinc-600">/</span>
            <span className="truncate text-xs text-zinc-600 dark:text-zinc-300">{root.path}</span>
            <span className="ml-auto text-[11px] text-zinc-500">
              {scan ? "Scanning…" : `Scanned ${formatRelative(root.lastScanAt)}`}
            </span>
          </>
        ) : null}
      </header>

      {error ? (
        <div className="flex shrink-0 items-center gap-3 border-b border-red-300/50 bg-red-500/10 px-4 py-1.5 text-xs text-red-800 dark:text-red-200">
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" className="ls-btn ls-btn-ghost" onClick={dismissError}>
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!ready ? (
            <EmptyState title="Starting the engine…" />
          ) : root ? (
            <CurrentView rootId={root.id} />
          ) : (
            <Welcome />
          )}
        </main>
      </div>

      <JobBar />
    </div>
  );
}

function CurrentView({ rootId }: { rootId: RootId }) {
  const { view } = useNavigation();

  switch (view) {
    case "overview":
      return <OverviewView rootId={rootId} />;
    case "library":
      return <LibraryView rootId={rootId} />;
    case "duplicates":
      return <DuplicatesView rootId={rootId} />;
    case "optimize":
      return <OptimizeView rootId={rootId} />;
    case "sound":
      return <SoundView rootId={rootId} />;
    case "holding":
      return <HoldingView rootId={rootId} />;
    case "journal":
      return <JournalView rootId={rootId} />;
    case "settings":
      return <SettingsView rootId={rootId} />;
    default: {
      const _exhaustive: never = view;

      return _exhaustive;
    }
  }
}

async function addRoot(report: (cause: unknown) => void, select: (rootId: RootId) => void) {
  try {
    const folder = await desktop.pickRoot();

    if (folder) {
      select((await call("addRoot", { path: folder })).id);
    }
  } catch (error) {
    report(error);
  }
}

function Welcome() {
  const { report, selectRoot } = useEngine();

  return (
    <EmptyState title="Add an archive root to begin">
      <p>
        Glazier scans a folder, reports what is in it, and plans changes you review before anything
        moves. Scanning never writes inside the folder.
      </p>
      <button
        type="button"
        className="ls-btn ls-btn-cta mt-4"
        onClick={() => void addRoot(report, selectRoot)}
      >
        <FolderPlus className="size-3.5" /> Add a root
      </button>
    </EmptyState>
  );
}

function Sidebar() {
  const { roots, rootId, selectRoot, report } = useEngine();
  const { view, go } = useNavigation();

  return (
    <nav
      aria-label="Glazier"
      className="flex w-52 shrink-0 flex-col border-r ls-divider bg-zinc-50/70 dark:bg-zinc-900/30"
    >
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="ls-label">Roots</span>
        <button
          type="button"
          className="ls-btn ls-btn-ghost px-1.5"
          title="Add a root"
          aria-label="Add a root"
          onClick={() => void addRoot(report, selectRoot)}
        >
          <FolderPlus className="size-3.5" />
        </button>
      </div>
      <ul className="space-y-0.5 px-2">
        {roots.map((root) => (
          <li key={root.id} className="group">
            <button
              type="button"
              aria-current={root.id === rootId}
              onClick={() => selectRoot(root.id)}
              title={root.path}
              className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-xs ${
                root.id === rootId
                  ? "bg-zinc-200/70 dark:bg-zinc-800"
                  : "hover:bg-zinc-100 dark:hover:bg-zinc-900"
              }`}
            >
              <span className="truncate">{root.name}</span>
              <span className="tabular shrink-0 text-[10px] text-zinc-500">
                {formatBytes(root.totalBytes)}
              </span>
            </button>
            {root.id === rootId ? (
              <div className="flex gap-1 px-2 pt-0.5 pb-1">
                <button
                  type="button"
                  className="ls-btn ls-btn-ghost px-1.5 py-0.5 text-[11px]"
                  onClick={() => void call("scanRoot", { rootId: root.id }).catch(report)}
                >
                  <RefreshCw className="size-3" /> Rescan
                </button>
                <button
                  type="button"
                  className="ls-btn ls-btn-ghost px-1.5 py-0.5 text-[11px]"
                  title="Forget this root (its files are untouched)"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Forget ${root.path}? Its files and holding folder stay on disk.`,
                      )
                    ) {
                      void call("removeRoot", { rootId: root.id }).catch(report);
                    }
                  }}
                >
                  <Trash2 className="size-3" /> Forget
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {roots.length > 0 ? (
        <>
          <div className="px-3 pt-4 pb-1">
            <span className="ls-label">Views</span>
          </div>
          <ul className="space-y-0.5 px-2">
            {NAV.map((entry) => (
              <li key={entry.view}>
                <button
                  type="button"
                  aria-current={entry.view === view}
                  onClick={() => go(entry.view)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs ${
                    entry.view === view
                      ? "bg-zinc-200/70 font-medium dark:bg-zinc-800"
                      : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900"
                  }`}
                >
                  <entry.icon className="size-3.5" />
                  {entry.label}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <div className="mt-auto px-3 py-3 text-[10px] text-zinc-500">
        {roots.length > 0
          ? `${formatCount(roots.reduce((sum, root) => sum + root.fileCount, 0))} files cataloged`
          : ""}
      </div>
    </nav>
  );
}
