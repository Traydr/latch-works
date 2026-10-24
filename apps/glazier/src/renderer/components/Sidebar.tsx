import type { Root, Tidy } from "@latch-works/glazier-core/contract";
import {
  Copy,
  History,
  Library,
  ListChecks,
  MoreHorizontal,
  Plus,
  Settings as SettingsIcon,
} from "lucide-react";
import type { ComponentType } from "react";

import { call, desktop } from "../lib/api";
import { useEngine, useEngineQuery } from "../lib/engine-state";
import { formatBytes, formatCount } from "../lib/format";
import { useNavigation, type View } from "../lib/navigation";
import { Kbd } from "./ui";

const NAV = [
  { view: "tidy", label: "Tidy", icon: ListChecks, key: "1" },
  { view: "duplicates", label: "Duplicates", icon: Copy, key: "2" },
  { view: "library", label: "Library", icon: Library, key: "3" },
  { view: "history", label: "History", icon: History, key: "4" },
] as const satisfies ReadonlyArray<{
  view: View;
  label: string;
  icon: ComponentType<{ className?: string }>;
  key: string;
}>;

/** How many Tidy steps still have work: duplicates, conversions, silent tracks, clean-up. */
function openTidySteps(tidy: Tidy): number {
  const steps = [
    tidy.duplicates.exact.sets + tidy.duplicates.similar.sets,
    tidy.convert.categories
      .filter((category) => !category.category.startsWith("rename-"))
      .reduce((sum, category) => sum + category.files, 0),
    tidy.silentTracks.files,
    tidy.cleanup.junk + tidy.cleanup.emptyFolders + tidy.cleanup.extensions,
  ];

  return steps.filter((count) => count > 0).length;
}

/** Forgets a root after a native sheet that says what forgetting loses. */
async function forgetRoot(root: Root, report: (cause: unknown) => void): Promise<void> {
  const confirmed = await desktop.confirm({
    message: `Forget “${root.name}”?`,
    detail:
      "Glazier forgets this folder's catalog and its undo history. The files and the holding folder stay on disk.",
    confirmLabel: "Forget",
    destructive: true,
  });

  if (confirmed) {
    await call("removeRoot", { rootId: root.id }).catch(report);
  }
}

export function Sidebar({
  onAddRoot,
  onSettings,
}: {
  onAddRoot: () => void;
  onSettings: () => void;
}) {
  const { roots, rootId, selectRoot, report } = useEngine();
  const { view, go } = useNavigation();
  const tidy = useEngineQuery("tidy", rootId === null ? null : { rootId });

  const badges: Partial<Record<View, number>> = tidy.data
    ? {
        tidy: openTidySteps(tidy.data),
        duplicates: tidy.data.duplicates.exact.sets + tidy.data.duplicates.similar.sets,
      }
    : {};

  const rootMenu = async (root: Root) => {
    const choice = await desktop.showMenu([
      { type: "item", id: "rescan", label: "Rescan", accelerator: "CmdOrCtrl+R" },
      { type: "item", id: "reveal", label: "Show in Finder" },
      { type: "separator" },
      { type: "item", id: "forget", label: "Forget…" },
    ]);

    switch (choice) {
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
    <nav
      aria-label="Glazier"
      className="flex w-52 shrink-0 flex-col border-r ls-divider bg-zinc-50/70 dark:bg-zinc-900/30"
    >
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="ls-label">Folders</span>
        <button
          type="button"
          className="ls-btn ls-btn-ghost px-1.5 py-0.5"
          title="Add a folder (⌘O)"
          aria-label="Add a folder"
          onClick={onAddRoot}
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      <ul className="space-y-0.5 px-2">
        {roots.map((root) => (
          <li key={root.id} className="group relative">
            <button
              type="button"
              aria-current={root.id === rootId}
              onClick={() => selectRoot(root.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                void rootMenu(root);
              }}
              title={root.path}
              className={`flex w-full items-center justify-between gap-2 rounded-md py-1 pr-7 pl-2 text-left text-xs ${
                root.id === rootId
                  ? "bg-zinc-200/70 dark:bg-zinc-800"
                  : "hover:bg-zinc-100 dark:hover:bg-zinc-900"
              }`}
            >
              <span className="truncate">{root.name}</span>
              <span className="ls-mono shrink-0 text-[10px] text-zinc-500 tabular">
                {formatBytes(root.totalBytes)}
              </span>
            </button>
            <button
              type="button"
              aria-label={`${root.name} options`}
              onClick={() => void rootMenu(root)}
              className="absolute top-1/2 right-1 -translate-y-1/2 rounded p-0.5 text-zinc-500 opacity-0 group-hover:opacity-100 hover:bg-zinc-200 focus-visible:opacity-100 dark:hover:bg-zinc-700"
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>

      {roots.length > 0 ? (
        <ul className="mt-4 space-y-0.5 border-t ls-divider px-2 pt-3">
          {NAV.map((entry) => (
            <li key={entry.view}>
              <button
                type="button"
                aria-current={entry.view === view}
                data-view={entry.view}
                onClick={() => go(entry.view)}
                title={`${entry.label} (⌘${entry.key})`}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs ${
                  entry.view === view
                    ? "bg-zinc-200/70 font-medium dark:bg-zinc-800"
                    : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900"
                }`}
              >
                <entry.icon className="size-3.5" />
                <span className="flex-1">{entry.label}</span>
                {badges[entry.view] ? (
                  <span
                    className="ls-mono rounded bg-violet-500/15 px-1.5 text-[10px] text-violet-700 tabular dark:text-violet-200"
                    data-badge={entry.view}
                  >
                    {formatCount(badges[entry.view] ?? 0)}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-auto px-2 py-2">
        <button
          type="button"
          onClick={onSettings}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          <SettingsIcon className="size-3.5" />
          <span className="flex-1">Settings</span>
          <Kbd>⌘,</Kbd>
        </button>
      </div>
    </nav>
  );
}
