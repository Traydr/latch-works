import type { RootId } from "@latch-works/glazier-core/contract";
import { FolderPlus } from "lucide-react";
import { type DragEvent, useCallback, useEffect, useState } from "react";

import glazierIcon from "../../media/glazier-icon.svg";
import { SettingsSheet } from "./components/SettingsSheet";
import { ShortcutSheet } from "./components/ShortcutSheet";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { ToastProvider, useToasts } from "./components/Toasts";
import { EmptyState, Kbd } from "./components/ui";
import { ActionsProvider, useActions } from "./lib/actions";
import { call, desktop, onAppCommand } from "./lib/api";
import { dispatchCommand } from "./lib/commands";
import { EngineProvider, useEngine } from "./lib/engine-state";
import { isTextInputTarget, useViewKeys } from "./lib/hotkeys";
import { NavigationProvider, useNavigation } from "./lib/navigation";
import { useSystemTheme } from "./lib/use-system-theme";
import { DuplicatesView } from "./views/DuplicatesView";
import { HistoryView } from "./views/HistoryView";
import { LibraryView } from "./views/LibraryView";
import { TidyView } from "./views/TidyView";

export function App() {
  useSystemTheme();

  return (
    <ToastProvider>
      <EngineProvider>
        <NavigationProvider>
          <ActionsProvider>
            <Shell />
          </ActionsProvider>
        </NavigationProvider>
      </EngineProvider>
    </ToastProvider>
  );
}

type Sheet = "settings" | "shortcuts" | null;

const VIEW_COMMANDS = {
  "view:tidy": "tidy",
  "view:duplicates": "duplicates",
  "view:library": "library",
  "view:history": "history",
} as const;

function Shell() {
  const { ready, roots, rootId, error, dismissError, selectRoot, report } = useEngine();
  const { go, requestSearch } = useNavigation();
  const { undoLast } = useActions();
  const toasts = useToasts();
  const [sheet, setSheet] = useState<Sheet>(null);
  const [dragging, setDragging] = useState(false);
  const root = roots.find((candidate) => candidate.id === rootId) ?? null;

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
        go("tidy");
      } catch (cause) {
        report(cause);
      }
    },
    [go, report, selectRoot],
  );

  const chooseFolder = useCallback(
    () => void desktop.pickRoot().then(addFolder, report),
    [addFolder, report],
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
            setSheet("settings");
            break;
          case "shortcuts":
            setSheet("shortcuts");
            break;
          case "view:tidy":
          case "view:duplicates":
          case "view:library":
          case "view:history":
            setSheet(null);
            go(VIEW_COMMANDS[command]);
            break;
          default: {
            const _exhaustive: never = command;

            return _exhaustive;
          }
        }
      }),
    [chooseFolder, go, report, requestSearch, rootId, undoLast],
  );

  useViewKeys((event) => {
    if (event.key === "?") {
      setSheet("shortcuts");

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
      className="flex h-screen flex-col overflow-hidden bg-white text-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
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
      <header className="flex h-[30px] shrink-0 items-center gap-2 border-b ls-divider bg-zinc-50 px-3 dark:bg-zinc-900/60">
        <img src={glazierIcon} className="size-3.5 shrink-0" alt="" />
        <span className="text-xs font-semibold tracking-tight">Glazier</span>
        {root ? (
          <>
            <span className="text-xs text-zinc-400 dark:text-zinc-600">/</span>
            <span className="truncate text-xs text-zinc-600 dark:text-zinc-300">{root.path}</span>
          </>
        ) : null}
      </header>

      <div className="relative flex min-h-0 flex-1">
        {roots.length > 0 ? (
          <Sidebar onAddRoot={chooseFolder} onSettings={() => setSheet("settings")} />
        ) : null}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!ready ? (
            <EmptyState title="Starting…" />
          ) : root ? (
            <CurrentView rootId={root.id} />
          ) : (
            <Welcome onChoose={chooseFolder} />
          )}
        </main>
        {dragging ? (
          <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-violet-400 bg-violet-500/10 text-sm font-medium text-violet-700 dark:text-violet-200">
            Drop a folder to add it
          </div>
        ) : null}
      </div>

      <StatusBar onShortcuts={() => setSheet("shortcuts")} />

      {sheet === "settings" ? (
        <SettingsSheet rootId={rootId} onClose={() => setSheet(null)} />
      ) : null}
      {sheet === "shortcuts" ? <ShortcutSheet onClose={() => setSheet(null)} /> : null}
    </div>
  );
}

function CurrentView({ rootId }: { rootId: RootId }) {
  const { view } = useNavigation();

  switch (view) {
    case "tidy":
      return <TidyView rootId={rootId} />;
    case "duplicates":
      return <DuplicatesView rootId={rootId} />;
    case "library":
      return <LibraryView rootId={rootId} />;
    case "history":
      return <HistoryView rootId={rootId} />;
    default: {
      const _exhaustive: never = view;

      return _exhaustive;
    }
  }
}

function Welcome({ onChoose }: { onChoose: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
      <img src={glazierIcon} className="size-12" alt="" />
      <h1 className="text-sm font-semibold">Choose the folder that holds your archive</h1>
      <p className="max-w-sm text-xs text-zinc-500">
        Glazier finds duplicates and converts files to AVIF and MP4. Every change can be undone.
      </p>
      <button type="button" className="ls-btn ls-btn-cta mt-1" onClick={onChoose}>
        <FolderPlus className="size-3.5" /> Choose Folder… <Kbd>⌘O</Kbd>
      </button>
      <p className="text-[11px] text-zinc-500">or drop a folder here</p>
    </div>
  );
}
