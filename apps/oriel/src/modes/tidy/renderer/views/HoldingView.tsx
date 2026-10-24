import type {
  HoldingId,
  HoldingItem,
  PlanId,
  PlanSummary,
  RootId,
} from "@latch-works/glazier-core/contract";
import { Archive, FolderOpen, X } from "lucide-react";
import { type MouseEvent, type ReactNode, useMemo, useRef, useState } from "react";
import { EmptyState, Spinner, TopBar } from "../../../../ui/ui";
import { LoadMore, usePages } from "../components/history/paging";
import { Thumb } from "../components/history/Thumb";
import { useToastLift, useToasts } from "../components/Toasts";
import { call, desktop } from "../lib/api";
import { useCommandHandler } from "../lib/commands";
import { useEngine, useEngineQuery } from "../lib/engine-state";
import { formatBytes, formatCount, formatDay, formatTime, plural, relativeTo } from "../lib/format";
import { useEmptyHolding } from "../lib/holding";
import { isCommandKey, useNow, useViewKeys } from "../lib/hotkeys";

/** Holding can hold tens of thousands of files; they arrive a page at a time as the user scrolls. */
const PAGE_SIZE = 300;

/** The change that put a run of files in holding, or none for files held on their own. */
interface Group {
  key: string;
  plan: PlanSummary | null;
  planId: PlanId | null;
  items: HoldingItem[];
}

function groupItems(items: readonly HoldingItem[]): Group[] {
  const groups = new Map<string, Group>();

  for (const item of items) {
    const key = item.planId === null ? "loose" : `plan:${item.planId}`;
    const group = groups.get(key);

    if (group) {
      group.items.push(item);
    } else {
      groups.set(key, { key, plan: null, planId: item.planId, items: [item] });
    }
  }

  return [...groups.values()];
}

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).at(-1) ?? filePath;
}

/**
 * The tile above or below `from`, by where the tiles sit on screen: the nearest line first, then
 * the nearest column. Each group has its own grid, so this is how a move crosses a group header.
 */
function verticalNeighbour(
  from: HTMLElement,
  tiles: ReadonlyMap<HoldingId, HTMLElement>,
  down: boolean,
): HoldingId | null {
  const origin = from.getBoundingClientRect();
  let best: { id: HoldingId; dy: number; dx: number } | null = null;

  for (const [id, tile] of tiles) {
    const rect = tile.getBoundingClientRect();
    const dy = Math.round(down ? rect.top - origin.bottom : origin.top - rect.bottom);
    const dx = Math.abs(rect.left - origin.left);

    if (dy >= 0 && (best === null || dy < best.dy || (dy === best.dy && dx < best.dx))) {
      best = { id, dy, dx };
    }
  }

  return best?.id ?? null;
}

export function HoldingView({ rootId }: { rootId: RootId }) {
  const { roots, report } = useEngine();
  const toasts = useToasts();
  const emptyHolding = useEmptyHolding(rootId);
  const now = useNow();
  const root = roots.find((candidate) => candidate.id === rootId);
  const [selected, setSelected] = useState<ReadonlySet<HoldingId>>(new Set());
  const [anchor, setAnchor] = useState<HoldingId | null>(null);
  /** The keyboard cursor: the tile the arrows move from, Space looks at, and the ring marks. */
  const [cursor, setCursor] = useState<HoldingId | null>(null);
  const tiles = useRef(new Map<HoldingId, HTMLButtonElement>());
  const [restoring, setRestoring] = useState(false);
  const [emptying, setEmptying] = useState(false);

  const holding = usePages(
    `holding:${rootId}`,
    (offset, limit) => call("listHolding", { rootId, offset, limit }),
    PAGE_SIZE,
  );

  // Group headers name the change; the newest plans cover what holding usually has.
  const plans = useEngineQuery("listPlans", { rootId, offset: 0, limit: 500 });

  const pages = holding.pages;
  const first = pages?.[0];
  const items = useMemo(() => pages?.flatMap((page) => page.items) ?? [], [pages]);
  const hasMore = first !== undefined && items.length < first.total;

  const groups = useMemo(() => {
    const byId = new Map((plans.data ?? []).map((plan) => [plan.id, plan]));

    return groupItems(items).map((group) => ({
      ...group,
      plan: group.planId === null ? null : (byId.get(group.planId) ?? null),
    }));
  }, [items, plans.data]);

  /** The tiles in the order they show, group by group, which ranges and arrows follow. */
  const ordered = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const chosen = ordered.flatMap((item) => (selected.has(item.id) ? [item] : []));
  const total = first?.total ?? 0;

  const clear = () => {
    setSelected(new Set());
    setAnchor(null);
  };

  const restore = async (ids: HoldingId[]) => {
    if (ids.length === 0) {
      return;
    }

    setRestoring(true);

    try {
      const result = await call("restoreHolding", { ids });

      clear();
      toasts.show(
        result.failed.length > 0
          ? {
              message: `Restored ${plural(result.restored, "file")}; ${formatCount(result.failed.length)} could not go back`,
              detail: result.failed[0] ?? null,
              tone: "error",
            }
          : { message: `Restored ${plural(result.restored, "file")}` },
      );
    } catch (error) {
      report(error);
    } finally {
      setRestoring(false);
      holding.refresh();
    }
  };

  const empty = async () => {
    if (!first) {
      return;
    }

    setEmptying(true);

    try {
      await emptyHolding({ files: first.total, bytes: first.totalBytes });
    } finally {
      setEmptying(false);
      clear();
      // Emptying does not change the catalog, so nothing else would refetch holding.
      holding.refresh();
    }
  };

  /** Click picks one, ⌘-click adds or removes one, ⇧-click picks the run from the last pick. */
  const select = (event: MouseEvent, item: HoldingItem) => {
    const from = anchor === null ? -1 : ordered.findIndex((candidate) => candidate.id === anchor);

    setCursor(item.id);

    if (event.shiftKey && from !== -1) {
      const to = ordered.indexOf(item);
      const run = ordered.slice(Math.min(from, to), Math.max(from, to) + 1);
      const next = new Set(isCommandKey(event.nativeEvent) ? selected : []);

      for (const candidate of run) {
        next.add(candidate.id);
      }

      setSelected(next);

      return;
    }

    if (isCommandKey(event.nativeEvent)) {
      const next = new Set(selected);

      if (!next.delete(item.id)) {
        next.add(item.id);
      }

      setSelected(next);
    } else {
      setSelected(new Set([item.id]));
    }

    setAnchor(item.id);
  };

  /** Moves the cursor to a tile, picking it alone or, with ⇧, the run from the anchor. */
  const moveCursor = (target: HoldingItem, extend: boolean) => {
    const tile = tiles.current.get(target.id);

    setCursor(target.id);
    tile?.focus({ preventScroll: true });
    tile?.scrollIntoView({ block: "nearest" });

    if (!extend) {
      setSelected(new Set([target.id]));
      setAnchor(target.id);

      return;
    }

    const start = anchor ?? cursor ?? target.id;
    const from = ordered.findIndex((candidate) => candidate.id === start);
    const to = ordered.indexOf(target);
    const run = ordered.slice(Math.min(from, to), Math.max(from, to) + 1);

    setSelected(new Set(run.map((candidate) => candidate.id)));
    setAnchor(start);
  };

  useCommandHandler("select-all", () => setSelected(new Set(ordered.map((item) => item.id))));

  // Finder's Trash keys: ⌘⌫ puts the selection back, ⇧⌘⌫ empties.
  useViewKeys((event) => {
    if (isCommandKey(event) && event.key === "Backspace") {
      if (event.shiftKey) {
        if (total > 0 && !emptying) {
          void empty();
        }

        return total > 0;
      }

      if (chosen.length > 0 && !restoring) {
        void restore(chosen.map((item) => item.id));
      }

      return chosen.length > 0;
    }

    if (event.metaKey || event.ctrlKey || event.altKey || ordered.length === 0) {
      return false;
    }

    const index = cursor === null ? -1 : ordered.findIndex((item) => item.id === cursor);
    const current = ordered[index];

    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight": {
        const step = event.key === "ArrowRight" ? 1 : -1;
        const target = ordered[current ? Math.min(ordered.length - 1, index + step) : 0];

        if (target) {
          moveCursor(target, event.shiftKey);
        }

        return true;
      }

      case "ArrowUp":
      case "ArrowDown": {
        const tile = current ? tiles.current.get(current.id) : undefined;
        const id = tile ? verticalNeighbour(tile, tiles.current, event.key === "ArrowDown") : null;
        const target = current ? ordered.find((item) => item.id === id) : ordered[0];

        if (target) {
          moveCursor(target, event.shiftKey);
        }

        return true;
      }

      case " ": {
        const target = current ?? chosen[0];

        if (target) {
          void desktop.quickLook(target.holdPath);
        }

        return target !== undefined;
      }

      case "Escape":
        if (chosen.length > 0) {
          clear();
        }

        return chosen.length > 0;
      default:
        return false;
    }
  });

  return (
    <>
      <TopBar
        title="Holding"
        meta={
          total > 0 && first ? `${plural(total, "file")} · ${formatBytes(first.totalBytes)}` : null
        }
      >
        {total > 0 ? (
          <button
            type="button"
            className="gz-btn gz-btn-danger"
            title="Empty to Trash  ⇧⌘⌫"
            disabled={emptying}
            onClick={() => void empty()}
          >
            {emptying ? <Spinner /> : null}
            Empty to Trash
          </button>
        ) : null}
      </TopBar>
      {!pages ? (
        <div className="flex-1" />
      ) : total === 0 ? (
        <EmptyState icon={Archive} title="Holding is empty">
          Removed files and replaced originals wait here until you empty them to the Trash.
        </EmptyState>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="px-5 pb-28">
            {groups.map((group) => (
              <section key={group.key}>
                <h2 className="sticky top-0 z-10 -mx-5 flex h-9 items-center gap-1.5 bg-white/90 px-5 text-[13px] font-medium backdrop-blur-md dark:bg-zinc-950/90">
                  <GroupTitle group={group} now={now} />
                </h2>
                <ul className="grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-3 pt-1 pb-6">
                  {group.items.map((item) => (
                    <HeldTile
                      key={item.id}
                      item={item}
                      rootPath={root?.path}
                      selected={selected.has(item.id)}
                      current={item.id === cursor}
                      tileRef={(element) => {
                        if (element) {
                          tiles.current.set(item.id, element);
                        } else {
                          tiles.current.delete(item.id);
                        }
                      }}
                      onSelect={(event) => select(event, item)}
                      onRestore={() => void restore([item.id])}
                    />
                  ))}
                </ul>
              </section>
            ))}
            {hasMore ? <LoadMore key={pages.length} onVisible={holding.loadMore} /> : null}
            {hasMore ? null : (
              <p className="gz-caption mx-auto max-w-[560px] pt-4 text-center">
                Files here stay recoverable until you empty them. To bring Pane View in line
                afterwards, run <Command>lockstep plan</Command>, then <Command>push</Command> and{" "}
                <Command>prune</Command>.
              </p>
            )}
          </div>
        </div>
      )}
      {chosen.length > 0 ? (
        <SelectionBar
          count={chosen.length}
          busy={restoring}
          onRestore={() => void restore(chosen.map((item) => item.id))}
          onReveal={() => {
            if (chosen[0]) {
              void desktop.reveal(chosen[0].holdPath);
            }
          }}
          onClear={clear}
        />
      ) : null}
    </>
  );
}

function GroupTitle({ group, now }: { group: Group; now: number }) {
  if (group.planId === null) {
    return <span>Moved to holding</span>;
  }

  const when = group.plan?.createdAt ?? group.items[0]?.heldAt ?? 0;

  return (
    <>
      <span className="truncate">{group.plan?.title ?? "Earlier change"}</span>
      <span className="shrink-0 font-normal text-zinc-500">
        · {formatDay(when, now)} {formatTime(when)}
      </span>
    </>
  );
}

function Command({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-zinc-900/[0.05] px-1 py-px font-mono text-zinc-700 select-all dark:bg-white/[0.07] dark:text-zinc-300">
      {children}
    </code>
  );
}

/** A held file, letterboxed so the picture keeps its shape, with its name, size and time held. */
function HeldTile({
  item,
  rootPath,
  selected,
  current,
  tileRef,
  onSelect,
  onRestore,
}: {
  item: HoldingItem;
  rootPath: string | undefined;
  selected: boolean;
  /** The keyboard cursor's tile carries the screen's one violet ring. */
  current: boolean;
  tileRef: (element: HTMLButtonElement | null) => void;
  onSelect: (event: MouseEvent) => void;
  onRestore: () => void;
}) {
  const name = fileName(item.originalPath);

  return (
    <li className="group relative" data-file-name={name}>
      <button
        ref={tileRef}
        type="button"
        aria-pressed={selected}
        title={`${relativeTo(rootPath, item.originalPath)}\n${item.reason}`}
        onClick={onSelect}
        onDoubleClick={() => void desktop.quickLook(item.holdPath)}
        className={`gz-card gz-focus block w-full scroll-mt-11 scroll-mb-24 p-1 text-left ${
          current
            ? "ring-2 ring-violet-500"
            : selected
              ? "ring-2 ring-zinc-900/25 dark:ring-white/30"
              : ""
        } ${selected ? "gz-selected" : ""}`}
      >
        <span className="gz-well flex aspect-[4/3] w-full items-center justify-center overflow-hidden">
          <Thumb path={item.holdPath} size={384} fit="contain" className="size-full" />
        </span>
        <span className="block px-1.5 pt-1.5 pb-1">
          <span className="block truncate text-[13px] text-zinc-900 dark:text-zinc-100">
            {name}
          </span>
          <span className="gz-caption block truncate">
            {formatBytes(item.size)} · {formatTime(item.heldAt)}
          </span>
        </span>
      </button>
      <button
        type="button"
        className="gz-btn gz-btn-secondary gz-btn-sm absolute top-2.5 right-2.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100"
        onClick={onRestore}
      >
        Restore
      </button>
    </li>
  );
}

/** Frame View's floating capsule, for what to do with the picked tiles. */
function SelectionBar({
  count,
  busy,
  onRestore,
  onReveal,
  onClear,
}: {
  count: number;
  busy: boolean;
  onRestore: () => void;
  onReveal: () => void;
  onClear: () => void;
}) {
  useToastLift(64);

  return (
    <div className="gz-float gz-enter-rise absolute bottom-5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 p-1.5">
      <button
        type="button"
        className="gz-btn gz-btn-primary gz-btn-sm"
        title="Restore  ⌘⌫"
        disabled={busy}
        onClick={onRestore}
      >
        {busy ? <Spinner /> : null}
        Restore {formatCount(count)}
      </button>
      <button type="button" className="gz-btn gz-btn-secondary gz-btn-sm" onClick={onReveal}>
        <FolderOpen />
        Show in Finder
      </button>
      <button
        type="button"
        className="gz-btn gz-btn-ghost gz-btn-icon-sm"
        aria-label="Clear selection"
        title="Clear selection  Esc"
        onClick={onClear}
      >
        <X />
      </button>
    </div>
  );
}
