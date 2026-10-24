import { formatBytes } from "@latch-works/media-domain";
import { Check, ChevronDown, ChevronRight, X } from "lucide-react";
import { useMemo, useState } from "react";

import type { LockstepPlanItem } from "../../shared/types";
import type { ItemRunState } from "../hooks/useLockstepController";
import {
  buildPlanTree,
  flattenPlanTree,
  folderPaths,
  type PlanFile,
  type PlanFolder,
} from "../lib/plan-tree";
import { ActionChip, Spinner } from "./syncPrimitives";

/** Plans up to this size open every folder; larger ones open only small folders. */
const OPEN_ALL_LIMIT = 300;

const OPEN_FOLDER_LIMIT = 40;

interface PlanTreeProps {
  items: readonly LockstepPlanItem[];
  /** Per-path run state while a push or prune is on screen; null shows the plain plan. */
  itemStates: ReadonlyMap<string, ItemRunState> | null;
  itemStatesVersion: number;
  emptyHint: string;
}

export function PlanTree({ items, itemStates, itemStatesVersion, emptyHint }: PlanTreeProps) {
  const [openOverrides, setOpenOverrides] = useState(() => new Map<string, boolean>());
  const [showAllFiles, setShowAllFiles] = useState(() => new Set<string>());
  const root = useMemo(() => buildPlanTree(items), [items]);

  const rows = useMemo(() => {
    const openByDefault = (folder: PlanFolder) =>
      root.itemCount <= OPEN_ALL_LIMIT || folder.itemCount <= OPEN_FOLDER_LIMIT;

    return flattenPlanTree({
      isOpen: (folder) => openOverrides.get(folder.path) ?? openByDefault(folder),
      root,
      showAllFiles,
    });
  }, [openOverrides, root, showAllFiles]);

  // Folder progress reads the mutable state map, so it recomputes on each state change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: itemStatesVersion versions itemStates.
  const folderProgress = useMemo(() => {
    const progress = new Map<string, { done: number; failed: number }>();

    if (!itemStates) {
      return progress;
    }

    for (const row of rows) {
      if (row.type !== "folder") {
        continue;
      }

      let done = 0;
      let failed = 0;

      for (const path of folderPaths(row.folder)) {
        const state = itemStates.get(path)?.type;

        if (state === "done" || state === "skipped") {
          done += 1;
        } else if (state === "failed") {
          failed += 1;
        }
      }

      progress.set(row.folder.path, { done, failed });
    }

    return progress;
  }, [itemStates, itemStatesVersion, rows]);

  if (rows.length === 0) {
    return <p className="px-3 py-8 text-center text-xs text-zinc-500">{emptyHint}</p>;
  }

  const toggle = (folder: PlanFolder, open: boolean) => {
    setOpenOverrides((current) => new Map(current).set(folder.path, !open));
  };

  return (
    <section aria-label="Plan changes">
      {rows.map((row) => {
        const indent = { paddingLeft: `${12 + row.depth * 14}px` };

        if (row.type === "folder") {
          const progress = folderProgress.get(row.folder.path);

          return (
            <button
              key={`folder:${row.folder.path}`}
              type="button"
              aria-expanded={row.open}
              onClick={() => toggle(row.folder, row.open)}
              style={indent}
              className="grid h-[26px] w-full grid-cols-[14px_minmax(0,1fr)_76px_64px] items-center gap-2 border-b border-zinc-200/70 bg-zinc-50/80 pr-3 text-left hover:bg-zinc-100 dark:border-zinc-800/60 dark:bg-zinc-900/50 dark:hover:bg-zinc-800/50"
            >
              {row.open ? (
                <ChevronDown className="size-3 text-zinc-500" aria-hidden />
              ) : (
                <ChevronRight className="size-3 text-zinc-500" aria-hidden />
              )}
              <span className="truncate ls-mono text-[11.5px] text-zinc-800 dark:text-zinc-100">
                {row.folder.label}/
              </span>
              <span className="text-right ls-mono text-[11px] text-zinc-500 tabular-nums">
                {formatSize(row.folder.size)}
              </span>
              <span className="text-right ls-mono text-[11px] text-zinc-500 tabular-nums">
                {progress ? (
                  <>
                    {progress.done + progress.failed}/{row.folder.itemCount}
                    {progress.failed > 0 ? (
                      <span className="text-red-600 dark:text-red-300"> ·{progress.failed}✕</span>
                    ) : null}
                  </>
                ) : (
                  row.folder.itemCount.toLocaleString()
                )}
              </span>
            </button>
          );
        }

        if (row.type === "more") {
          return (
            <button
              key={`more:${row.folder.path}`}
              type="button"
              style={indent}
              onClick={() => setShowAllFiles((current) => new Set(current).add(row.folder.path))}
              className="block h-[26px] w-full border-b border-zinc-200/70 pr-3 text-left text-[11px] text-zinc-500 hover:text-zinc-800 dark:border-zinc-800/60 dark:hover:text-zinc-200"
            >
              Show {row.hidden.toLocaleString()} more in {row.folder.label || "this folder"}
            </button>
          );
        }

        return (
          <FileRow
            key={`file:${row.file.path}`}
            file={row.file}
            indent={indent}
            state={itemStates?.get(row.file.path) ?? null}
          />
        );
      })}
    </section>
  );
}

function FileRow({
  file,
  indent,
  state,
}: {
  file: PlanFile;
  indent: { paddingLeft: string };
  state: ItemRunState | null;
}) {
  const tone =
    state?.type === "active"
      ? "bg-violet-500/10 shadow-[inset_2px_0_0_var(--color-violet-500)]"
      : state?.type === "failed"
        ? "bg-red-500/[0.07] shadow-[inset_2px_0_0_var(--color-red-500)]"
        : "";

  const faded = state?.type === "done" || state?.type === "skipped";

  return (
    <div className={`border-b border-zinc-200/70 dark:border-zinc-800/60 ${tone}`}>
      <div
        style={indent}
        className={`grid h-[26px] grid-cols-[14px_minmax(0,1fr)_76px_64px] items-center gap-2 pr-3 ${faded ? "opacity-45" : ""}`}
      >
        <StateMark state={state} />
        <span className="flex min-w-0 items-center gap-2">
          <ActionChip action={file.action} />
          <span
            className={`truncate ls-mono text-[11.5px] ${state?.type === "failed" ? "text-red-700 dark:text-red-300" : "text-zinc-700 dark:text-zinc-300"}`}
            title={file.path}
          >
            {file.name}
          </span>
        </span>
        <span className="text-right ls-mono text-[11px] text-zinc-500 tabular-nums">
          {formatSize(file.size)}
        </span>
        <span className="truncate text-right ls-mono text-[10.5px] text-zinc-500">
          {state?.type === "skipped" ? "skipped" : null}
        </span>
      </div>
      {state?.type === "failed" || state?.type === "skipped" ? (
        <p
          style={{ paddingLeft: `calc(${indent.paddingLeft} + 22px)` }}
          className={`truncate pr-3 pb-1.5 ls-mono text-[10.5px] ${state.type === "failed" ? "text-red-700 dark:text-red-300" : "text-zinc-500"}`}
          title={state.type === "failed" ? state.error : state.reason}
        >
          {state.type === "failed" ? state.error : state.reason}
        </p>
      ) : null}
    </div>
  );
}

function StateMark({ state }: { state: ItemRunState | null }) {
  switch (state?.type) {
    case "active":
      return <Spinner />;
    case "done":
    case "skipped":
      return <Check className="size-3 text-emerald-600 dark:text-emerald-400" aria-label="done" />;
    case "failed":
      return <X className="size-3 text-red-600 dark:text-red-400" aria-label="failed" />;
    case undefined:
      return <span />;
    default: {
      const _exhaustive: never = state;

      return _exhaustive;
    }
  }
}

function formatSize(size: number | undefined): string {
  return size === undefined || size === 0 ? "—" : formatBytes(size);
}
