import type {
  DuplicateScope,
  DuplicateSet,
  DuplicateSetPage,
  FileId,
  FileRow,
  KeepReason,
  RootId,
  SimilarityLevel,
} from "@latch-works/glazier-core/contract";
import { Star } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { CompareStage } from "../components/CompareStage";
import { describeDetails, Thumbnail } from "../components/media";
import { SIMILARITY_LEVELS } from "../components/SettingsSheet";
import { useToasts } from "../components/Toasts";
import { EmptyState, Kbd, Spinner, Toggle, ViewHeader } from "../components/ui";
import { useActions } from "../lib/actions";
import { call, desktop, thumbnailUrl } from "../lib/api";
import { useActiveJob, useEngine } from "../lib/engine-state";
import {
  formatBytes,
  formatCount,
  formatDate,
  formatDuration,
  formatLabel,
  plural,
} from "../lib/format";
import { digitOf, isCommandKey, isPlainKey, useViewKeys } from "../lib/hotkeys";
import { usePreferFolder } from "../lib/preferences";

const PAGE_SIZE = 100;

const QUEUE_ROW_HEIGHT = 52;

const KEEP_REASONS = {
  "preferred-folder": "preferred folder",
  "has-sound": "has sound",
  "more-pixels": "most pixels",
  longer: "longest",
  "archive-format": "archive format",
  "right-extension": "right extension",
  "larger-file": "largest file",
  "original-name": "original name",
  oldest: "oldest",
  "shorter-path": "shortest path",
  "name-order": "first by name",
} as const satisfies Record<KeepReason, string>;

const AUDIO_LABELS = {
  none: "no track",
  silent: "silent",
  sound: "sound",
  unmeasured: "not measured",
} as const;

/** One line of a set's version table: a version, or for identical copies, one copy. */
interface SetRow {
  file: FileRow;
  /** Byte-identical copies that go with this version. */
  copies: FileRow[];
}

function rowsOf(set: DuplicateSet): SetRow[] {
  if (set.kind === "exact") {
    return (set.versions[0]?.files ?? []).map((file) => ({ file, copies: [] }));
  }

  return set.versions.flatMap((version) => {
    const [file, ...copies] = version.files;

    return file ? [{ file, copies }] : [];
  });
}

function filesOf(set: DuplicateSet): FileRow[] {
  return set.versions.flatMap((version) => version.files);
}

/** Whether the owner's choice of keepers still names files of this set. */
function fitsSet(set: DuplicateSet, keep: readonly FileId[]): boolean {
  const members = new Set(filesOf(set).map((file) => file.id));

  return keep.length > 0 && keep.every((id) => members.has(id));
}

/** What resolving keeps: the owner's choice when it still fits the set, else the suggestion. */
function keptIds(set: DuplicateSet, override: readonly FileId[] | undefined): FileId[] {
  return override && fitsSet(set, override) ? [...override] : set.keep;
}

function removalOf(set: DuplicateSet, kept: readonly FileId[]): FileRow[] {
  const keep = new Set(kept);

  return filesOf(set).filter((file) => !keep.has(file.id));
}

function freedBytes(set: DuplicateSet, removed: readonly FileRow[]): number {
  const linked = new Set(set.hardLinkedIds);

  return removed.reduce((sum, file) => sum + (linked.has(file.id) ? 0 : file.size), 0);
}

function pixelsOf(file: FileRow): number | null {
  return file.width !== null && file.height !== null ? file.width * file.height : null;
}

function ratioLabel(ratio: number, noun: string): string | null {
  if (ratio > 0.97 && ratio < 1.03) {
    return null;
  }

  if (ratio < 1) {
    return ratio <= 0.55
      ? `1/${Math.round(1 / ratio)} the ${noun}`
      : `${Math.round(ratio * 100)}% of the ${noun}`;
  }

  return `${ratio.toFixed(ratio >= 10 ? 0 : 1)}× the ${noun}`;
}

/** How a version compares with the kept one, in a few words. */
function compareNotes(row: SetRow, keeper: FileRow, linked: ReadonlySet<FileId>): string[] {
  const notes: string[] = [];

  if (row.file.id !== keeper.id) {
    const pixels = pixelsOf(row.file);
    const keeperPixels = pixelsOf(keeper);

    if (pixels !== null && keeperPixels) {
      const label = ratioLabel(pixels / keeperPixels, "pixels");

      if (label) {
        notes.push(label);
      }
    }

    const size = ratioLabel(row.file.size / Math.max(1, keeper.size), "size");

    if (size) {
      notes.push(size);
    }

    if (row.file.durationMs !== null && keeper.durationMs !== null) {
      const seconds = Math.round((row.file.durationMs - keeper.durationMs) / 1000);

      if (seconds !== 0) {
        notes.push(`${Math.abs(seconds)} s ${seconds < 0 ? "shorter" : "longer"}`);
      }
    }
  }

  if (row.copies.length > 0) {
    notes.push(`+${plural(row.copies.length, "identical copy", "identical copies")}`);
  }

  if (linked.has(row.file.id)) {
    notes.push("hard link");
  }

  return notes;
}

interface QueueRequest {
  rootId: RootId;
  level: SimilarityLevel;
  scope: DuplicateScope;
  dismissed: boolean;
}

/**
 * The sets, loaded a page at a time as the queue scrolls. A refresh (any catalog change) reloads
 * as many as were loaded and swaps them in at once, so the list never blanks.
 */
function useSetQueue(request: QueueRequest) {
  const { catalogVersion, report } = useEngine();
  const key = JSON.stringify(request);

  const [loaded, setLoaded] = useState<{
    key: string;
    version: number;
    data: DuplicateSetPage;
  } | null>(null);

  const [wanted, setWanted] = useState({ key, count: PAGE_SIZE });
  const count = wanted.key === key ? wanted.count : PAGE_SIZE;
  const requestRef = useRef(request);
  const latest = useRef("");

  requestRef.current = request;

  useEffect(() => {
    const stamp = `${key}|${catalogVersion}|${count}`;
    const current = requestRef.current;
    const version = catalogVersion;

    latest.current = stamp;

    const load = async () => {
      let result: DuplicateSetPage | null = null;

      // Fetches in chunks of the method's 500 limit until `count` sets are in hand.
      while (result === null || (result.sets.length < count && result.sets.length < result.total)) {
        const offset: number = result?.sets.length ?? 0;

        const chunk = await call("duplicateSets", {
          rootId: current.rootId,
          level: current.level,
          scope: current.scope,
          dismissed: current.dismissed,
          offset,
          limit: Math.min(500, count - offset),
        });

        result = result === null ? chunk : { ...chunk, sets: [...result.sets, ...chunk.sets] };

        if (chunk.sets.length === 0) {
          break;
        }
      }

      if (latest.current === stamp) {
        setLoaded({ key, version, data: result });
      }
    };

    load().catch(report);
  }, [key, catalogVersion, count, report]);

  const current = loaded?.key === key ? loaded : null;

  const loadMore = useCallback(() => {
    const next = current ? current.data.sets.length + PAGE_SIZE : 0;

    if (current && current.data.sets.length < current.data.total && next > count) {
      setWanted({ key, count: next });
    }
  }, [current, key, count]);

  return { data: current?.data ?? null, version: current?.version ?? -1, loadMore };
}

export function DuplicatesView({ rootId }: { rootId: RootId }) {
  const { settings, setSettings, catalogVersion, report } = useEngine();
  const actions = useActions();
  const toasts = useToasts();
  const preferFolder = usePreferFolder(rootId);
  const similarJob = useActiveJob("similar", rootId);
  const level = settings?.similarity ?? "balanced";
  const [scope, setScope] = useState<DuplicateScope>("all");
  const [dismissedMode, setDismissedMode] = useState(false);
  const queue = useSetQueue({ rootId, level, scope, dismissed: dismissedMode });
  const [activeIndex, setActiveIndex] = useState(0);
  const [focusedRow, setFocusedRow] = useState(1);
  const [zoomed, setZoomed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [overrides, setOverrides] = useState<ReadonlyMap<string, FileId[]>>(new Map());
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  // Sets resolved or dismissed here stay hidden until a refresh newer than that change arrives.
  const [hidden, setHidden] = useState<ReadonlyMap<string, number>>(new Map());
  const versionRef = useRef(catalogVersion);

  versionRef.current = catalogVersion;

  const sets = useMemo(
    () =>
      (queue.data?.sets ?? []).filter((set) => {
        const until = hidden.get(set.key);

        return until === undefined || queue.version > until;
      }),
    [queue.data, queue.version, hidden],
  );

  const index = Math.min(activeIndex, Math.max(0, sets.length - 1));
  const active = sets[index] ?? null;
  const rows = useMemo(() => (active ? rowsOf(active) : []), [active]);
  const kept = active ? keptIds(active, overrides.get(active.key)) : [];
  const keptSet = new Set(kept);
  const removed = active ? removalOf(active, kept) : [];
  const activeKey = active?.key ?? null;

  // A new set starts with focus on its first version that would go, at fit size, paused.
  useEffect(() => {
    if (activeKey !== null) {
      setFocusedRow(1);
      setZoomed(false);
      setPlaying(false);
    }
  }, [activeKey]);

  const focus = Math.min(focusedRow, Math.max(0, rows.length - 1));

  const hide = useCallback((key: string, until: number) => {
    setHidden((current) => new Map(current).set(key, until));
  }, []);

  const unhide = useCallback((key: string) => {
    setHidden((current) => {
      const next = new Map(current);

      next.delete(key);

      return next;
    });
  }, []);

  const resolve = useCallback(async () => {
    if (!active) {
      return;
    }

    const keep = keptIds(active, overrides.get(active.key));
    const remove = removalOf(active, keep).map((file) => file.id);

    if (remove.length === 0) {
      return;
    }

    hide(active.key, Number.POSITIVE_INFINITY);

    const plan = await actions.perform(
      { kind: "resolve-duplicates", groups: [{ keep, remove }] },
      { confirmLabel: "Remove anyway" },
    );

    if (plan) {
      hide(active.key, versionRef.current);
    } else {
      unhide(active.key);
    }
  }, [active, overrides, hide, unhide, actions]);

  const dismiss = useCallback(async () => {
    if (!active) {
      return;
    }

    const set = active;

    hide(set.key, Number.POSITIVE_INFINITY);

    try {
      const { dismissalId } = await call("dismissDuplicateSet", {
        fileIds: filesOf(set).map((file) => file.id),
      });

      hide(set.key, versionRef.current);

      const restore = async () => {
        await call("restoreDuplicateSet", { dismissalId });
        unhide(set.key);
      };

      actions.pushUndo(restore);
      toasts.show({
        message: "Marked as not duplicates",
        detail: rowsOf(set)[0]?.file.name ?? null,
        action: { label: "Undo", run: () => void restore().catch(report) },
      });
    } catch (error) {
      unhide(set.key);
      report(error);
    }
  }, [active, hide, unhide, actions, toasts, report]);

  const restoreDismissed = useCallback(async () => {
    if (!active || active.dismissalId === null) {
      return;
    }

    hide(active.key, Number.POSITIVE_INFINITY);

    try {
      await call("restoreDuplicateSet", { dismissalId: active.dismissalId });
      hide(active.key, versionRef.current);
    } catch (error) {
      unhide(active.key);
      report(error);
    }
  }, [active, hide, unhide, report]);

  const resolveAll = useCallback(() => {
    const valid = [...overrides].flatMap(([key, keep]) => {
      const set = sets.find((candidate) => candidate.key === key);

      return set && fitsSet(set, keep) ? [{ key, keep }] : [];
    });

    void actions.perform(
      {
        kind: "resolve-duplicate-sets",
        rootId,
        level,
        scope,
        overrides: valid,
        skip: [...skipped],
      },
      { confirmLabel: "Remove anyway" },
    );
  }, [overrides, sets, actions, rootId, level, scope, skipped]);

  const keepOnly = (rowIndex: number) => {
    const row = rows[rowIndex];

    if (active && row) {
      setOverrides((current) => new Map(current).set(active.key, [row.file.id]));
    }
  };

  const toggleKeep = (rowIndex: number) => {
    const row = rows[rowIndex];

    if (!active || !row) {
      return;
    }

    const next = keptSet.has(row.file.id)
      ? kept.filter((id) => id !== row.file.id)
      : [...kept, row.file.id];

    if (next.length > 0) {
      setOverrides((current) => new Map(current).set(active.key, next));
    }
  };

  const move = (delta: number) => {
    setActiveIndex(Math.max(0, Math.min(sets.length - 1, index + delta)));
  };

  const skip = () => {
    if (active) {
      setSkipped((current) => new Set(current).add(active.key));
      move(1);
    }
  };

  const hasVideo = rows.some((row) => row.file.kind === "video");

  useViewKeys((event) => {
    if (isCommandKey(event) && event.key === "Enter") {
      if (!dismissedMode && sets.length > 0) {
        resolveAll();
      }

      return true;
    }

    if (event.metaKey || event.ctrlKey || event.altKey) {
      return false;
    }

    const digit = digitOf(event);

    if (digit !== null) {
      if (!dismissedMode && digit <= rows.length) {
        if (event.shiftKey) {
          toggleKeep(digit - 1);
        } else {
          keepOnly(digit - 1);
        }

        setFocusedRow(digit - 1);
      }

      return true;
    }

    if (!isPlainKey(event)) {
      return false;
    }

    switch (event.key) {
      case "ArrowDown":
      case "j":
        move(1);

        return true;
      case "ArrowUp":
      case "k":
        move(-1);

        return true;
      case "ArrowRight":
      case "l":
      case "e":
        setFocusedRow(Math.min(rows.length - 1, focus + 1));

        return true;
      case "ArrowLeft":
      case "h":
      case "q":
        setFocusedRow(Math.max(0, focus - 1));

        return true;
      case "Enter":
        if (dismissedMode) {
          void restoreDismissed();
        } else if (removed.length > 0) {
          void resolve();
        } else {
          void dismiss();
        }

        return true;
      case "s":
      case "S":
        skip();

        return true;
      case "n":
      case "N":
        if (!dismissedMode) {
          void dismiss();
        }

        return true;
      case "p":
      case "P": {
        const row = rows[focus];

        if (row && !dismissedMode) {
          void preferFolder(row.file.dir);
        }

        return true;
      }

      case "z":
      case "Z":
        setZoomed((current) => !current);

        return true;
      case "m":
      case "M":
        setMuted((current) => !current);

        return true;
      case " ": {
        const row = rows[focus];

        if (hasVideo && active?.kind === "similar") {
          setPlaying((current) => !current);
        } else if (row) {
          void desktop.quickLook(row.file.absPath);
        }

        return true;
      }

      case "Escape":
        setZoomed(false);

        return zoomed;
      default:
        return false;
    }
  });

  const data = queue.data;
  const fingerprinting = data !== null && data.fingerprinted < data.fingerprintable;
  const keeperRow = rows.find((row) => keptSet.has(row.file.id)) ?? rows[0] ?? null;
  const keeperNumber = keeperRow ? rows.indexOf(keeperRow) + 1 : 1;
  const focusRow = rows[focus];

  const compareRow =
    focusRow && focusRow !== keeperRow ? focusRow : rows.find((row) => row !== keeperRow);

  // Sets hidden here still count in `total` until the refresh arrives.
  const remaining = data ? Math.max(sets.length, data.total - (data.sets.length - sets.length)) : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewHeader
        title="Duplicates"
        meta={
          data
            ? dismissedMode
              ? plural(remaining, "dismissed set")
              : `${plural(remaining, "set")} · ${formatBytes(data.reclaimableBytes)} to reclaim`
            : null
        }
      >
        {fingerprinting ? (
          <span
            className="ls-mono inline-flex items-center gap-1.5 text-[10.5px] text-zinc-500"
            title="Similar versions appear as each picture and video is checked"
          >
            {similarJob ? <Spinner /> : null}
            similar {formatCount(data?.fingerprinted ?? 0)}/
            {formatCount(data?.fingerprintable ?? 0)}
          </span>
        ) : null}
        {data && !dismissedMode ? (
          <Toggle
            label="Show"
            value={scope}
            onChange={(next) => {
              setScope(next);
              setActiveIndex(0);
            }}
            options={[
              { value: "all", label: "All", count: data.counts.exact + data.counts.similar },
              { value: "exact", label: "Identical", count: data.counts.exact },
              { value: "similar", label: "Similar", count: data.counts.similar },
            ]}
          />
        ) : null}
        <Toggle
          label="Match"
          value={level}
          onChange={(similarity) => settings && void setSettings({ ...settings, similarity })}
          options={SIMILARITY_LEVELS}
        />
        {data && (data.counts.dismissed > 0 || dismissedMode) ? (
          <button
            type="button"
            aria-pressed={dismissedMode}
            className={`ls-btn ${dismissedMode ? "ls-btn-primary" : "ls-btn-ghost"}`}
            onClick={() => {
              setDismissedMode((current) => !current);
              setActiveIndex(0);
            }}
          >
            {dismissedMode ? "Done" : `Dismissed ${formatCount(data.counts.dismissed)}`}
          </button>
        ) : null}
      </ViewHeader>

      {data === null ? (
        <EmptyState title="Finding duplicates…" />
      ) : sets.length === 0 ? (
        <EmptyState
          title={
            dismissedMode
              ? "Nothing dismissed"
              : fingerprinting
                ? "No duplicates found yet"
                : "No duplicates"
          }
        >
          {fingerprinting && !dismissedMode
            ? `Still checking for similar versions: ${formatCount(data.fingerprinted)} of ${formatCount(data.fingerprintable)}.`
            : null}
        </EmptyState>
      ) : (
        <div className="flex min-h-0 flex-1">
          <SetQueue
            sets={sets}
            total={remaining}
            activeIndex={index}
            skipped={skipped}
            overrides={overrides}
            onSelect={setActiveIndex}
            onNearEnd={queue.loadMore}
            footer={
              dismissedMode ? null : (
                <button
                  type="button"
                  className="ls-btn ls-btn-primary w-full justify-between"
                  onClick={resolveAll}
                  title="Resolve every remaining set in this list with its keeper"
                >
                  <span>
                    Resolve all {formatCount(Math.max(0, remaining - skipped.size))} ·{" "}
                    {formatBytes(data.reclaimableBytes)}
                  </span>
                  <Kbd>⌘↩</Kbd>
                </button>
              )
            }
          />

          {active ? (
            <section
              className="flex min-h-0 min-w-0 flex-1 flex-col"
              data-set-key={active.key}
              data-set-kind={active.kind}
            >
              <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
                {active.kind === "similar" && keeperRow ? (
                  <CompareStage
                    left={{ row: keeperRow.file, number: keeperNumber, kept: true }}
                    right={
                      compareRow
                        ? {
                            row: compareRow.file,
                            number: rows.indexOf(compareRow) + 1,
                            kept: keptSet.has(compareRow.file.id),
                          }
                        : null
                    }
                    zoomed={zoomed}
                    playing={playing}
                    muted={muted}
                  />
                ) : keeperRow ? (
                  <ExactPreview row={keeperRow.file} copies={rows.length} />
                ) : null}

                <VersionTable
                  set={active}
                  rows={rows}
                  kept={keptSet}
                  focus={focus}
                  keeper={keeperRow?.file ?? null}
                  readOnly={dismissedMode}
                  onFocus={setFocusedRow}
                  onKeepOnly={keepOnly}
                  onToggleKeep={toggleKeep}
                />
              </div>

              <div className="flex shrink-0 items-center gap-2 border-t ls-divider bg-zinc-50 px-4 py-2 dark:bg-zinc-900/60">
                <p className="ls-mono min-w-0 flex-1 truncate text-[10.5px] text-zinc-500">
                  {dismissedMode ? (
                    "You marked these as not duplicates."
                  ) : removed.length === 0 ? (
                    "Keeps every version, so resolving marks them as not duplicates."
                  ) : (
                    <>
                      keeps {keeperRow?.file.relPath}
                      {kept.length > 1 ? ` and ${kept.length - 1} more` : ""} ·{" "}
                      {plural(removed.length, "file")} to holding ·{" "}
                      {formatBytes(freedBytes(active, removed))}
                    </>
                  )}
                </p>
                {dismissedMode ? (
                  <button
                    type="button"
                    className="ls-btn ls-btn-cta"
                    onClick={() => void restoreDismissed()}
                  >
                    Restore <Kbd>↩</Kbd>
                  </button>
                ) : (
                  <>
                    <button type="button" className="ls-btn ls-btn-ghost" onClick={skip}>
                      Skip <Kbd>S</Kbd>
                    </button>
                    <button type="button" className="ls-btn" onClick={() => void dismiss()}>
                      Not duplicates <Kbd>N</Kbd>
                    </button>
                    <button
                      type="button"
                      className="ls-btn ls-btn-cta"
                      onClick={() => void (removed.length > 0 ? resolve() : dismiss())}
                    >
                      Resolve <Kbd>↩</Kbd>
                    </button>
                  </>
                )}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}

function SetQueue({
  sets,
  total,
  activeIndex,
  skipped,
  overrides,
  onSelect,
  onNearEnd,
  footer,
}: {
  sets: readonly DuplicateSet[];
  total: number;
  activeIndex: number;
  skipped: ReadonlySet<string>;
  overrides: ReadonlyMap<string, FileId[]>;
  onSelect: (index: number) => void;
  onNearEnd: () => void;
  footer: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);

  useLayoutEffect(() => {
    const element = container.current;

    if (!element) {
      return;
    }

    const observer = new ResizeObserver(() => setHeight(element.clientHeight));

    observer.observe(element);
    setHeight(element.clientHeight);

    return () => observer.disconnect();
  }, []);

  // Keyboard moves keep the active set in view.
  useEffect(() => {
    const element = container.current;

    if (!element) {
      return;
    }

    const top = activeIndex * QUEUE_ROW_HEIGHT;

    if (top < element.scrollTop) {
      element.scrollTop = top;
    } else if (top + QUEUE_ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + QUEUE_ROW_HEIGHT - element.clientHeight;
    }
  }, [activeIndex]);

  const first = Math.max(0, Math.floor(scrollTop / QUEUE_ROW_HEIGHT) - 6);
  const last = Math.min(sets.length, Math.ceil((scrollTop + height) / QUEUE_ROW_HEIGHT) + 6);

  useEffect(() => {
    if (Math.max(last, activeIndex) >= sets.length - 10 && sets.length < total) {
      onNearEnd();
    }
  }, [last, activeIndex, sets.length, total, onNearEnd]);

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r ls-divider">
      <div
        ref={container}
        className="relative min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div style={{ height: sets.length * QUEUE_ROW_HEIGHT }} className="relative">
          {sets.slice(first, last).map((set, offset) => {
            const position = first + offset;
            const files = filesOf(set);
            const kept = keptIds(set, overrides.get(set.key));
            const keeper = files.find((file) => kept.includes(file.id)) ?? files[0];

            return (
              <button
                key={set.key}
                type="button"
                aria-current={position === activeIndex}
                data-set-key={set.key}
                onClick={() => onSelect(position)}
                style={{ top: position * QUEUE_ROW_HEIGHT, height: QUEUE_ROW_HEIGHT }}
                className={`absolute inset-x-0 flex items-center gap-2.5 border-b border-zinc-100 px-3 text-left dark:border-zinc-900 ${
                  position === activeIndex
                    ? "bg-violet-500/10"
                    : "hover:bg-zinc-50 dark:hover:bg-zinc-900/60"
                } ${skipped.has(set.key) ? "opacity-50" : ""}`}
              >
                {keeper ? <Thumbnail row={keeper} size={32} /> : null}
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="truncate font-medium">{keeper?.name}</span>
                    <span className="ls-mono shrink-0 text-[10px] text-zinc-500">
                      {set.kind === "exact"
                        ? `${files.length} identical`
                        : `${set.versions.length} versions`}
                    </span>
                  </span>
                  <span className="ls-mono block truncate text-[10px] text-zinc-500">
                    {skipped.has(set.key)
                      ? "skipped"
                      : `keeps ${keeper?.dir || "/"} · ${
                          overrides.has(set.key) ? "your pick" : KEEP_REASONS[set.keepReason]
                        }`}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {footer ? <div className="shrink-0 border-t ls-divider p-2">{footer}</div> : null}
    </aside>
  );
}

function ExactPreview({ row, copies }: { row: FileRow; copies: number }) {
  return (
    <div className="flex min-h-0 flex-1 items-center gap-5 rounded-md bg-zinc-100 p-4 dark:bg-zinc-900">
      <div className="flex h-full max-h-96 min-h-0 w-1/2 items-center justify-center">
        {(row.kind === "image" || row.kind === "video") && row.probeError === null ? (
          <img
            src={thumbnailUrl(row.absPath, 512)}
            alt=""
            className="max-h-full max-w-full rounded object-contain"
          />
        ) : (
          <Thumbnail row={row} size={72} />
        )}
      </div>
      <div className="min-w-0 text-xs">
        <p className="font-medium">{plural(copies, "identical copy", "identical copies")}</p>
        <p className="ls-mono mt-1 text-[10.5px] text-zinc-500">
          {formatLabel(row.format)} · {describeDetails(row) || "—"} · {formatBytes(row.size)} each
        </p>
      </div>
    </div>
  );
}

function VersionTable({
  set,
  rows,
  kept,
  focus,
  keeper,
  readOnly,
  onFocus,
  onKeepOnly,
  onToggleKeep,
}: {
  set: DuplicateSet;
  rows: readonly SetRow[];
  kept: ReadonlySet<FileId>;
  focus: number;
  keeper: FileRow | null;
  readOnly: boolean;
  onFocus: (index: number) => void;
  onKeepOnly: (index: number) => void;
  onToggleKeep: (index: number) => void;
}) {
  const linked = new Set(set.hardLinkedIds);
  const showVideo = rows.some((row) => row.file.kind === "video");

  const dimensions = (file: FileRow | null) =>
    file?.width != null && file.height != null ? `${file.width}×${file.height}` : "—";

  return (
    <div className="max-h-[40%] shrink-0 overflow-y-auto rounded-md border ls-divider">
      <table className="w-full table-fixed text-xs">
        <colgroup>
          <col className="w-7" />
          <col className="w-7" />
          <col />
          <col className="w-12" />
          <col className="w-20" />
          {showVideo ? <col className="w-11" /> : null}
          {showVideo ? <col className="w-20" /> : null}
          <col className="w-16" />
          <col className="w-24" />
          <col className="w-40" />
        </colgroup>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
          {rows.map((row, index) => {
            const isKept = kept.has(row.file.id);
            const pixels = dimensions(row.file);

            const differs = (value: string, keeperValue: string) =>
              keeper && row.file.id !== keeper.id && value !== keeperValue
                ? "text-amber-700 dark:text-amber-300"
                : "";

            return (
              <tr
                key={row.file.id}
                data-row={index + 1}
                data-file-name={row.file.name}
                data-keep={isKept}
                onClick={() => onFocus(index)}
                onDoubleClick={() => void desktop.quickLook(row.file.absPath)}
                className={`cursor-default ${index === focus ? "bg-zinc-100 dark:bg-zinc-800/60" : ""} ${
                  isKept ? "" : "text-zinc-500"
                }`}
              >
                <td className="ls-mono py-1.5 pl-3 text-[10.5px] text-zinc-500">{index + 1}</td>
                <td className="py-1.5">
                  <button
                    type="button"
                    disabled={readOnly}
                    aria-pressed={isKept}
                    aria-label={isKept ? `Keeping ${row.file.name}` : `Keep ${row.file.name}`}
                    title="Keep only this · ⇧-click to keep it as well"
                    onClick={(event) => {
                      event.stopPropagation();

                      if (event.shiftKey || event.metaKey) {
                        onToggleKeep(index);
                      } else {
                        onKeepOnly(index);
                      }
                    }}
                    className="rounded p-0.5 hover:bg-zinc-200 disabled:pointer-events-none dark:hover:bg-zinc-700"
                  >
                    <Star
                      className={`size-3.5 ${isKept ? "fill-violet-500 text-violet-500" : "text-zinc-400"}`}
                    />
                  </button>
                </td>
                <td className="py-1 pr-2" title={row.file.relPath}>
                  <span
                    className={`block truncate ${
                      isKept
                        ? "text-zinc-800 dark:text-zinc-100"
                        : "line-through decoration-zinc-400/60"
                    }`}
                  >
                    {row.file.name}
                  </span>
                  <span className="ls-mono block truncate text-[10px] text-zinc-500">
                    {row.file.dir || "/"}
                  </span>
                </td>
                <td
                  className={`py-1.5 ${differs(formatLabel(row.file.format), formatLabel(keeper?.format ?? null))}`}
                >
                  {formatLabel(row.file.format)}
                </td>
                <td
                  className={`ls-mono py-1.5 text-[10.5px] tabular ${differs(pixels, dimensions(keeper))}`}
                >
                  {pixels}
                </td>
                {showVideo ? (
                  <td className="ls-mono py-1.5 text-[10.5px] tabular">
                    {formatDuration(row.file.durationMs)}
                  </td>
                ) : null}
                {showVideo ? (
                  <td
                    className={`py-1.5 text-[11px] ${differs(row.file.audioState ?? "", keeper?.audioState ?? "")}`}
                  >
                    {row.file.audioState ? AUDIO_LABELS[row.file.audioState] : ""}
                  </td>
                ) : null}
                <td className="ls-mono py-1.5 text-right text-[10.5px] tabular">
                  {formatBytes(row.file.size)}
                </td>
                <td className="ls-mono py-1.5 pl-3 text-[10.5px] text-zinc-500 tabular">
                  {formatDate(row.file.mtimeMs)}
                </td>
                <td className="truncate py-1.5 pr-3 text-[10.5px] text-zinc-500">
                  {keeper ? compareNotes(row, keeper, linked).join(" · ") : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
