import type { HoldingId, RootId } from "@latch-works/glazier-core/contract";
import { FolderOpen } from "lucide-react";
import { useState } from "react";

import { EmptyState, ViewHeader } from "../components/ui";
import { call, desktop } from "../lib/api";
import { useEngine, useEngineQuery } from "../lib/engine-state";
import { formatBytes, formatCount, formatDateTime } from "../lib/format";

const PAGE_SIZE = 200;

/** A path inside the root, shown without the root's own folders. */
function relativeTo(rootPath: string | undefined, filePath: string): string {
  return rootPath && filePath.startsWith(rootPath)
    ? filePath.slice(rootPath.length).replace(/^[\\/]+/, "")
    : filePath;
}

export function HoldingView({ rootId }: { rootId: RootId }) {
  const [offset, setOffset] = useState(0);
  const holding = useEngineQuery("listHolding", { rootId, offset, limit: PAGE_SIZE });
  const [selected, setSelected] = useState<Set<HoldingId>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const { report, roots } = useEngine();
  const root = roots.find((candidate) => candidate.id === rootId);
  const data = holding.data;

  const restore = async (ids: HoldingId[]) => {
    try {
      const result = await call("restoreHolding", { ids });
      setSelected(new Set());
      setNotice(
        result.failed.length > 0
          ? `Restored ${result.restored}; ${result.failed.length} could not go back: ${result.failed[0]}`
          : `Restored ${formatCount(result.restored)} files. A rescan adds them back to the catalog.`,
      );
      holding.refresh();
    } catch (error) {
      report(error);
    }
  };

  const empty = async () => {
    if (!window.confirm("Move everything in this root's holding folder to the Trash?")) {
      return;
    }

    try {
      const result = await desktop.emptyHolding(rootId);
      setNotice(
        result.failed.length > 0
          ? `Moved ${formatCount(result.emptied)} files to the Trash; some batches stayed: ${result.failed[0]}`
          : `Moved ${formatCount(result.emptied)} files to the Trash.`,
      );
      holding.refresh();
    } catch (error) {
      report(error);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewHeader
        title="Holding"
        description={
          data
            ? `${formatCount(data.total)} files · ${formatBytes(data.totalBytes)} in ${root?.name ?? "this root"}/.glazier-holding`
            : "Removed files and replaced originals, kept until you empty them."
        }
      >
        <button
          type="button"
          className="ls-btn"
          disabled={selected.size === 0}
          onClick={() => void restore([...selected])}
        >
          Restore selected
        </button>
        <button
          type="button"
          className="ls-btn ls-btn-danger"
          disabled={!data || data.total === 0}
          onClick={() => void empty()}
        >
          Empty to Trash
        </button>
      </ViewHeader>

      {notice ? (
        <p className="shrink-0 border-b ls-divider bg-sky-500/10 px-5 py-1.5 text-xs text-sky-800 dark:text-sky-200">
          {notice}
        </p>
      ) : null}

      {!data || data.total === 0 ? (
        <EmptyState title="Holding is empty">
          Files you remove, and originals replaced by a conversion, wait here. Lockstep and Frame
          View skip this folder, and the Trash only gets them when you empty it.
        </EmptyState>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full table-fixed text-xs">
            <colgroup>
              <col className="w-14" />
              <col />
              <col className="w-56" />
              <col className="w-24" />
              <col className="w-72" />
            </colgroup>
            <thead className="sticky top-0 bg-white dark:bg-zinc-950">
              <tr className="text-left text-[10px] tracking-wide text-zinc-500 uppercase">
                <th className="w-8 px-5 py-1.5">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={selected.size === data.items.length}
                    onChange={(event) =>
                      setSelected(
                        new Set(event.target.checked ? data.items.map((item) => item.id) : []),
                      )
                    }
                  />
                </th>
                <th className="py-1.5">Original path</th>
                <th className="py-1.5">Why</th>
                <th className="py-1.5 pr-4 text-right">Size</th>
                <th className="py-1.5 pr-5">Held</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {data.items.map((item) => (
                <tr key={item.id} data-holding={item.originalPath}>
                  <td className="px-5 py-1.5">
                    <input
                      type="checkbox"
                      aria-label={`Select ${item.originalPath}`}
                      checked={selected.has(item.id)}
                      onChange={(event) => {
                        const next = new Set(selected);

                        if (event.target.checked) {
                          next.add(item.id);
                        } else {
                          next.delete(item.id);
                        }

                        setSelected(next);
                      }}
                    />
                  </td>
                  <td className="truncate py-1.5" title={item.originalPath}>
                    {relativeTo(root?.path, item.originalPath)}
                  </td>
                  <td className="truncate py-1.5 text-zinc-500">{item.reason}</td>
                  <td className="tabular py-1.5 pr-4 text-right">{formatBytes(item.size)}</td>
                  <td className="tabular flex items-center gap-2 py-1.5 pr-5 text-zinc-500">
                    {formatDateTime(item.heldAt)}
                    <button
                      type="button"
                      className="ls-btn ls-btn-ghost px-1"
                      aria-label="Reveal"
                      onClick={() => void desktop.reveal(item.holdPath)}
                    >
                      <FolderOpen className="size-3" />
                    </button>
                    <button
                      type="button"
                      className="ls-btn ls-btn-ghost py-0"
                      onClick={() => void restore([item.id])}
                    >
                      Restore
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.total > PAGE_SIZE ? (
            <div className="flex justify-center gap-2 py-3">
              <button
                type="button"
                className="ls-btn"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </button>
              <button
                type="button"
                className="ls-btn"
                disabled={offset + PAGE_SIZE >= data.total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
