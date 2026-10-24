import { formatBytes } from "@latch-works/media-domain";
import { Check, ChevronDown, ChevronRight, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Spinner } from "../../../../ui/ui";
import type { LockstepPlanItem } from "../../shared/types";
import type { ItemRunState } from "../hooks/useLockstepController";
import {
  buildPlanTree,
  flattenPlanTree,
  folderPaths,
  type PlanFile,
  type PlanFolder,
} from "../lib/plan-tree";
import { ActionBadge } from "./syncPrimitives";

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
    return <p className="lw-caption px-5 py-12 text-center text-[13px]">{emptyHint}</p>;
  }

  const toggle = (folder: PlanFolder, open: boolean) => {
    setOpenOverrides((current) => new Map(current).set(folder.path, !open));
  };

  return (
    <section aria-label="Plan changes">
      {rows.map((row) => {
        const indent = { paddingLeft: `${20 + row.depth * 16}px` };

        if (row.type === "folder") {
          const progress = folderProgress.get(row.folder.path);

          return (
            <button
              key={`folder:${row.folder.path}`}
              type="button"
              aria-expanded={row.open}
              onClick={() => toggle(row.folder, row.open)}
              style={indent}
              className="lw-hover lw-focus grid h-8 w-full grid-cols-[16px_minmax(0,1fr)_84px_72px] items-center gap-2.5 border-b lw-divider pr-5 text-left"
            >
              {row.open ? (
                <ChevronDown className="size-3.5 text-zinc-400" aria-hidden />
              ) : (
                <ChevronRight className="size-3.5 text-zinc-400" aria-hidden />
              )}
              <span className="truncate text-[13px] font-medium">{row.folder.label}/</span>
              <span className="text-right text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
                {formatSize(row.folder.size)}
              </span>
              <span className="text-right text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
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
              className="lw-hover lw-focus block h-8 w-full border-b lw-divider pr-5 text-left text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
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
    <div className={`border-b lw-divider ${tone}`}>
      <div
        style={indent}
        className={`grid h-8 grid-cols-[16px_minmax(0,1fr)_84px_72px] items-center gap-2.5 pr-5 ${faded ? "opacity-45" : ""}`}
      >
        <StateMark state={state} />
        <span className="flex min-w-0 items-center gap-2.5">
          <ActionBadge action={file.action} />
          <span
            className={`truncate text-[13px] ${state?.type === "failed" ? "text-red-700 dark:text-red-300" : "text-zinc-800 dark:text-zinc-200"}`}
            title={file.path}
          >
            {file.name}
          </span>
        </span>
        <span className="text-right text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
          {formatSize(file.size)}
        </span>
        <span className="lw-caption truncate text-right">
          {state?.type === "skipped" ? "Skipped" : null}
        </span>
      </div>
      {state?.type === "failed" || state?.type === "skipped" ? (
        <p
          style={{ paddingLeft: `calc(${indent.paddingLeft} + 26px)` }}
          className={`truncate pr-5 pb-2 text-xs ${state.type === "failed" ? "text-red-700 dark:text-red-300" : "text-zinc-500 dark:text-zinc-400"}`}
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
      return (
        <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-label="done" />
      );
    case "failed":
      return <X className="size-3.5 text-red-600 dark:text-red-400" aria-label="failed" />;
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
