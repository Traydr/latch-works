import type { Job, RootId } from "@latch-works/glazier-core/contract";
import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";

import glazierIcon from "../../../../media/modes/glazier-icon.svg";
import { ModeLayout } from "../../../shell/ModeLayout";
import { type ModeActivity, useReportActivity, useShell } from "../../../shell/shell";
import { EmptyState, Kbd } from "../../../ui/ui";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FolderPickerProvider, useFolderPicker } from "./components/FolderPicker";
import { ShortcutSheet } from "./components/ShortcutSheet";
import { Sidebar } from "./components/Sidebar";
import { ToastProvider, ToastViewport, useToasts } from "./components/Toasts";
import { ActionsProvider, useActions } from "./lib/actions";
import { call, desktop, onAppCommand } from "./lib/api";
import { dispatchCommand } from "./lib/commands";
import { EngineProvider, useEngine } from "./lib/engine-state";
import { isTextInputTarget, useViewKeys } from "./lib/hotkeys";
import { NavigationProvider, useNavigation, type View } from "./lib/navigation";
import { CleanupView } from "./views/CleanupView";
import { ConvertView } from "./views/ConvertView";
import { DuplicatesView } from "./views/DuplicatesView";
import { HistoryView } from "./views/HistoryView";
import { HoldingView } from "./views/HoldingView";
import { LibraryView } from "./views/LibraryView";
import { OverviewView } from "./views/OverviewView";
import { TidySettings } from "./views/SettingsView";

/** Tidy: Glazier, the archive workbench, as one of Oriel's modes. */
export function TidyMode() {
  return (
    <ErrorBoundary>
      {window.glazier ? (
        <ToastProvider>
          <EngineProvider>
            <NavigationProvider>
              <ActionsProvider>
                <FolderPickerProvider>
                  <Shell />
                </FolderPickerProvider>
              </ActionsProvider>
            </NavigationProvider>
          </EngineProvider>
        </ToastProvider>
      ) : (
        <ModeLayout>
          <p className="p-6 text-sm">
            Tidy's desktop bridge is unavailable; the preload did not load.
          </p>
        </ModeLayout>
      )}
    </ErrorBoundary>
  );
}

const VIEW_COMMANDS = {
  "view:overview": "overview",
  "view:duplicates": "duplicates",
  "view:convert": "convert",
  "view:cleanup": "cleanup",
  "view:library": "library",
  "view:history": "history",
  "view:holding": "holding",
} as const satisfies Record<string, View>;

/**
 * What Tidy's switcher button shows while another mode is on: a ring for a change to the archive
 * (applying a plan or undoing one), a dot for a scan or analysis.
 */
function jobActivity(jobs: readonly Job[]): ModeActivity | null {
  const going = jobs.filter((job) => job.state === "running" || job.state === "queued");
  const change = going.find((job) => job.type === "apply" || job.type === "undo");

  if (change) {
    return { kind: "progress", ratio: change.total > 0 ? change.done / change.total : 0 };
  }

  return going.some((job) => job.state === "running") ? { kind: "working" } : null;
}

function Shell() {
  const { ready, roots, rootId, error, dismissError, selectRoot, report, jobs } = useEngine();
  const { go, requestSearch, view } = useNavigation();
  const { undoLast } = useActions();
  const toasts = useToasts();
  const [shortcuts, setShortcuts] = useState(false);
  const { rail, openSettings } = useShell();
  const [dragging, setDragging] = useState(false);
  const root = roots.find((candidate) => candidate.id === rootId) ?? null;
  const main = useRef<HTMLElement>(null);

  useReportActivity(jobActivity(jobs));

  // A view opened from the sidebar takes the focus, so the sidebar item keeps no focus ring while
  // the view's keys are used.
  useEffect(() => {
    if (view && main.current && !main.current.contains(document.activeElement)) {
      main.current.focus({ preventScroll: true });
    }
  }, [view]);

  // Engine errors surface as toasts, like every other result.
  useEffect(() => {
    if (error) {
      toasts.show({ message: "Something went wrong", detail: error, tone: "error" });
      dismissError();
    }
  }, [error, dismissError, toasts]);

  const addFolder = useCallback(
    async (folder: string | null) => {
      if (!folder) {
        return;
      }

      try {
        const added = await call("addRoot", { path: folder });

        selectRoot(added.id);
        go("overview");
      } catch (cause) {
        report(cause);
      }
    },
    [go, report, selectRoot],
  );

  const pickFolder = useFolderPicker();
  const rootPath = root?.path ?? null;

  // Opens beside the current root, highlighted, since a second root is usually its neighbour.
  const chooseFolder = useCallback(
    () =>
      void pickFolder({
        title: "Choose a folder to tidy",
        action: "Choose",
        start: rootPath === null ? null : `${rootPath}/..`,
        select: rootPath,
      }).then(addFolder, report),
    [addFolder, pickFolder, report, rootPath],
  );

  useEffect(
    () =>
      onAppCommand((command) => {
        const typing = isTextInputTarget(document.activeElement);

        switch (command) {
          case "add-root":
            chooseFolder();
            break;
          case "rescan":
            if (rootId !== null) {
              void call("scanRoot", { rootId }).catch(report);
            }

            break;
          case "undo":
            if (typing) {
              document.execCommand("undo");
            } else {
              void undoLast();
            }

            break;
          case "select-all":
            if (typing) {
              document.execCommand("selectAll");
            } else {
              dispatchCommand("select-all");
            }

            break;
          case "find":
            requestSearch();
            break;
          case "settings":
            setShortcuts(false);
            openSettings("tidy");
            break;
          case "shortcuts":
            setShortcuts(true);
            break;
          case "view:overview":
          case "view:duplicates":
          case "view:convert":
          case "view:cleanup":
          case "view:library":
          case "view:history":
          case "view:holding":
            setShortcuts(false);
            go(VIEW_COMMANDS[command]);
            break;
          default: {
            const _exhaustive: never = command;

            return _exhaustive;
          }
        }
      }),
    [chooseFolder, go, openSettings, report, requestSearch, rootId, undoLast],
  );

  useViewKeys((event) => {
    if (event.key === "?") {
      setShortcuts(true);

      return true;
    }

    return false;
  });

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);

    for (const file of Array.from(event.dataTransfer.files)) {
      void addFolder(desktop.pathForFile(file));
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the whole window takes a dropped folder; ⌘O is the keyboard path.
    <div
      className="h-full"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) {
          setDragging(false);
        }
      }}
      onDrop={onDrop}
    >
      <ModeLayout
        sidebar={root ? <Sidebar onAddRoot={chooseFolder} rail={rail} /> : undefined}
        settings={<TidySettings rootId={root?.id ?? null} />}
      >
        <main
          ref={main}
          tabIndex={-1}
          className="relative flex min-h-0 min-w-0 flex-1 flex-col outline-none"
        >
          {!ready ? (
            <>
              <div className="lw-drag h-[52px] shrink-0" />
              <EmptyState title="Starting…" />
            </>
          ) : root ? (
            <CurrentView rootId={root.id} />
          ) : (
            <Welcome onChoose={chooseFolder} dragging={dragging} />
          )}
          <ToastViewport />
        </main>
      </ModeLayout>
      {dragging && root ? (
        <div className="pointer-events-none fixed inset-3 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-violet-400 bg-violet-500/10 text-[15px] font-medium text-violet-700 dark:text-violet-200">
          Drop a folder to add it
        </div>
      ) : null}

      {shortcuts ? <ShortcutSheet onClose={() => setShortcuts(false)} /> : null}
    </div>
  );
}

function CurrentView({ rootId }: { rootId: RootId }) {
  const { view } = useNavigation();

  switch (view) {
    case "overview":
      return <OverviewView rootId={rootId} />;
    case "duplicates":
      return <DuplicatesView rootId={rootId} />;
    case "convert":
      return <ConvertView rootId={rootId} />;
    case "cleanup":
      return <CleanupView rootId={rootId} />;
    case "library":
      return <LibraryView rootId={rootId} />;
    case "history":
      return <HistoryView rootId={rootId} />;
    case "holding":
      return <HoldingView rootId={rootId} />;
    default: {
      const _exhaustive: never = view;

      return _exhaustive;
    }
  }
}

function Welcome({ onChoose, dragging }: { onChoose: () => void; dragging: boolean }) {
  return (
    <>
      <div className="lw-drag h-[52px] shrink-0" />
      <div className="flex flex-1 items-center justify-center p-10 pb-[100px]">
        <div
          className={`flex w-[480px] max-w-full flex-col items-center rounded-2xl border-2 border-dashed px-10 py-12 text-center transition-colors duration-150 ${
            dragging ? "border-violet-400 bg-violet-500/5" : "border-zinc-200 dark:border-white/10"
          }`}
        >
          <img src={glazierIcon} className="size-14" alt="" />
          <h1 className="mt-4 text-xl font-semibold">Choose your media archive</h1>
          <p className="mt-2 max-w-[360px] text-sm text-zinc-500 dark:text-zinc-400">
            Glazier finds duplicates, converts files to AVIF and MP4, and cleans up junk. Every
            change can be undone.
          </p>
          <button type="button" className="lw-btn lw-btn-primary lw-btn-xl mt-6" onClick={onChoose}>
            Choose folder… <Kbd>⌘O</Kbd>
          </button>
          <p className="lw-caption mt-3">or drop a folder here</p>
        </div>
      </div>
    </>
  );
}
