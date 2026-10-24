import type { PlanSummary, RootId } from "@latch-works/glazier-core/contract";
import { ChevronRight, History } from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";

import { LoadMore, usePages } from "../components/history/paging";
import { PlanIcon, PlanSteps, ResolveSets } from "../components/history/plan-parts";
import { useToasts } from "../components/Toasts";
import { EmptyState, Spinner, TopBar } from "../components/ui";
import { canUndo, describePlan, useActions } from "../lib/actions";
import { call } from "../lib/api";
import { useEngine } from "../lib/engine-state";
import {
  formatBytes,
  formatCount,
  formatDateTime,
  formatDay,
  formatRelative,
  plural,
} from "../lib/format";
import { isPlainKey, useNow, useViewKeys } from "../lib/hotkeys";

const PAGE_SIZE = 200;

/** Duplicate resolutions made one after another within this long read as one session. */
const SESSION_GAP_MS = 10 * 60_000;

const RESOLVE_KINDS = new Set<PlanSummary["kind"]>([
  "resolve-duplicates",
  "resolve-duplicate-sets",
]);

const STATUS_LABELS = {
  draft: "Draft",
  applying: "Running",
  applied: null,
  partial: "Partly done",
  failed: "Failed",
  cancelled: "Stopped",
  undone: null,
} as const satisfies Record<PlanSummary["status"], string | null>;

/** One row of the log: a plan, or a run of duplicate resolutions made in one sitting. */
interface Entry {
  key: string;
  /** Newest first. */
  plans: PlanSummary[];
}

function groupPlans(plans: readonly PlanSummary[]): Entry[] {
  const entries: Entry[] = [];

  for (const plan of plans) {
    const previous = entries.at(-1);
    const last = previous?.plans.at(-1);

    if (
      previous &&
      last &&
      RESOLVE_KINDS.has(plan.kind) &&
      RESOLVE_KINDS.has(last.kind) &&
      last.createdAt - plan.createdAt < SESSION_GAP_MS &&
      canUndo(last) === canUndo(plan)
    ) {
      previous.plans.push(plan);
    } else {
      entries.push({ key: String(plan.id), plans: [plan] });
    }
  }

  return entries;
}

function entryTitle(entry: Entry): string {
  const [first] = entry.plans;

  if (!first) {
    return "";
  }

  if (entry.plans.length === 1) {
    return first.title;
  }

  const sets = entry.plans.reduce((sum, plan) => sum + plan.count, 0);

  return `Resolved ${plural(sets, "duplicate set")}`;
}

function entryDetail(entry: Entry): string {
  if (entry.plans.length === 1 && entry.plans[0]) {
    return describePlan(entry.plans[0]);
  }

  if (entry.plans.every((plan) => plan.status === "undone")) {
    return "undone";
  }

  let files = 0;
  let bytes = 0;

  for (const plan of entry.plans) {
    files += plan.held.files;
    bytes += plan.held.bytes;
  }

  return files > 0 ? `${plural(files, "file")} to holding · ${formatBytes(bytes)}` : "";
}

function addTo(set: ReadonlySet<string>, key: string): Set<string> {
  return new Set(set).add(key);
}

function removeFrom(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set);

  next.delete(key);

  return next;
}

export function HistoryView({ rootId }: { rootId: RootId }) {
  const { roots } = useEngine();
  const { undoPlan } = useActions();
  const toasts = useToasts();
  const now = useNow();
  const root = roots.find((candidate) => candidate.id === rootId);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<ReadonlySet<string>>(new Set());
  const rows = useRef(new Map<string, HTMLButtonElement>());

  const plans = usePages(
    `plans:${rootId}`,
    (offset, limit) => call("listPlans", { rootId, offset, limit }),
    PAGE_SIZE,
  );

  const pages = plans.pages;
  const entries = useMemo(() => groupPlans(pages?.flat() ?? []), [pages]);
  const hasMore = (pages?.at(-1)?.length ?? 0) === PAGE_SIZE;
  const newestUndoable = entries.find((entry) => entry.plans.some(canUndo))?.key ?? null;

  const days = useMemo(() => {
    const grouped: Array<{ label: string; entries: Entry[] }> = [];

    for (const entry of entries) {
      const label = formatDay(entry.plans[0]?.createdAt ?? 0, now);
      const last = grouped.at(-1);

      if (last?.label === label) {
        last.entries.push(entry);
      } else {
        grouped.push({ label, entries: [entry] });
      }
    }

    return grouped;
  }, [entries, now]);

  const toggle = (key: string, open = !expanded.has(key)) =>
    setExpanded((current) => (open ? addTo(current, key) : removeFrom(current, key)));

  const undoEntry = async (entry: Entry) => {
    const undoable = entry.plans.filter(canUndo);
    const [only] = undoable;

    if (!only || undoing.has(entry.key)) {
      return;
    }

    setUndoing((current) => addTo(current, entry.key));

    try {
      if (undoable.length === 1) {
        await undoPlan(only);
      } else {
        let done = true;

        // Newest first, as ⌘Z would take them back.
        for (const plan of undoable) {
          if (!(await undoPlan(plan, { quiet: true }))) {
            done = false;

            break;
          }
        }

        if (done) {
          toasts.show({ message: `Undid “${entryTitle(entry)}”`, tone: "info" });
        }
      }
    } finally {
      setUndoing((current) => removeFrom(current, entry.key));
      plans.refresh();
    }
  };

  const undoOne = async (plan: PlanSummary) => {
    await undoPlan(plan);
    plans.refresh();
  };

  const focusRow = (key: string) => {
    setFocused(key);
    rows.current.get(key)?.focus();
  };

  useViewKeys((event) => {
    if (!isPlainKey(event) || entries.length === 0) {
      return false;
    }

    const index = entries.findIndex((entry) => entry.key === focused);
    const current = entries[index];

    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        const step = event.key === "ArrowDown" ? 1 : -1;
        const target = index === -1 ? 0 : Math.max(0, Math.min(entries.length - 1, index + step));
        const next = entries[target];

        if (next) {
          focusRow(next.key);
        }

        return true;
      }

      case "ArrowRight":
      case "ArrowLeft":
        if (current) {
          toggle(current.key, event.key === "ArrowRight");
        }

        return current !== undefined;
      case "u":
      case "U":
        if (current) {
          void undoEntry(current);
        }

        return current !== undefined;
      default:
        return false;
    }
  });

  const caption =
    entries.length === 0
      ? null
      : `${formatCount(entries.length)}${hasMore ? "+" : ""} ${
          entries.length === 1 ? "change" : "changes"
        }`;

  return (
    <>
      <TopBar title="History" meta={caption} />
      {!pages ? (
        <div className="flex-1" />
      ) : entries.length === 0 ? (
        <EmptyState icon={History} title="No changes yet">
          Every change you make shows up here with an Undo.
        </EmptyState>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[760px] px-6 pt-6 pb-28">
            {days.map((day, index) => (
              <section key={day.label}>
                <h2 className={`pb-2 text-xs font-medium text-zinc-500 ${index > 0 ? "pt-6" : ""}`}>
                  {day.label}
                </h2>
                <ul className="gz-card overflow-hidden">
                  {day.entries.map((entry) => (
                    <ChangeRow
                      key={entry.key}
                      entry={entry}
                      now={now}
                      expanded={expanded.has(entry.key)}
                      newest={entry.key === newestUndoable}
                      undoing={undoing.has(entry.key)}
                      buttonRef={(element) => {
                        if (element) {
                          rows.current.set(entry.key, element);
                        } else {
                          rows.current.delete(entry.key);
                        }
                      }}
                      onFocus={() => setFocused(entry.key)}
                      onToggle={() => toggle(entry.key)}
                      onUndo={() => void undoEntry(entry)}
                    >
                      {entry.plans.length > 1 ? (
                        <ResolveSets
                          plans={entry.plans}
                          rootId={rootId}
                          rootPath={root?.path}
                          rootName={root?.name ?? "the top folder"}
                          onUndo={undoOne}
                        />
                      ) : entry.plans[0] ? (
                        <PlanSteps plan={entry.plans[0]} rootPath={root?.path} />
                      ) : null}
                    </ChangeRow>
                  ))}
                </ul>
              </section>
            ))}
            {hasMore ? <LoadMore key={pages.length} onVisible={plans.loadMore} /> : null}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * A change: what it was, its numbers, when, and Undo. The whole row is the disclosure; a button
 * stretched under the content takes the click and the keyboard focus.
 */
function ChangeRow({
  entry,
  now,
  expanded,
  newest,
  undoing,
  buttonRef,
  onFocus,
  onToggle,
  onUndo,
  children,
}: {
  entry: Entry;
  now: number;
  expanded: boolean;
  /** The newest row that can be undone keeps its Undo in view. */
  newest: boolean;
  undoing: boolean;
  buttonRef: (element: HTMLButtonElement | null) => void;
  onFocus: () => void;
  onToggle: () => void;
  onUndo: () => void;
  children: ReactNode;
}) {
  const [latest] = entry.plans;

  if (!latest) {
    return null;
  }

  const title = entryTitle(entry);
  const undoable = entry.plans.filter(canUndo).length;
  const statuses = new Set(entry.plans.map((plan) => STATUS_LABELS[plan.status]));
  const status = statuses.size === 1 ? [...statuses][0] : null;
  const undone = entry.plans.every((plan) => plan.status === "undone");

  return (
    <li
      data-plan={latest.id}
      data-status={latest.status}
      className="border-t gz-divider first:border-t-0"
    >
      <div className="group relative flex h-14 items-center gap-3 px-4">
        <button
          ref={buttonRef}
          type="button"
          aria-expanded={expanded}
          aria-label={title}
          onFocus={onFocus}
          onClick={onToggle}
          className="gz-focus absolute inset-0 transition-[background-color] duration-150 hover:bg-zinc-900/[0.03] dark:hover:bg-white/[0.03]"
        />
        <PlanIcon kind={latest.kind} />
        <div className="pointer-events-none relative min-w-0 flex-1">
          <p className={`truncate text-sm font-medium ${undone ? "text-zinc-500" : ""}`}>{title}</p>
          <p className="gz-caption truncate">{entryDetail(entry)}</p>
        </div>
        {status ? (
          <span className="gz-badge gz-badge-warn pointer-events-none relative">{status}</span>
        ) : null}
        <time
          className="gz-caption relative shrink-0"
          dateTime={new Date(latest.createdAt).toISOString()}
          title={formatDateTime(latest.createdAt)}
        >
          {formatRelative(latest.createdAt, now)}
        </time>
        {undoable > 0 ? (
          <button
            type="button"
            title="Undo  U"
            disabled={undoing}
            onClick={onUndo}
            className={`gz-btn gz-btn-secondary gz-btn-sm relative ${
              newest
                ? ""
                : "opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
            }`}
          >
            {undoing ? <Spinner /> : null}
            {undoable > 1 ? `Undo all ${undoable}` : "Undo"}
          </button>
        ) : null}
        <ChevronRight
          className={`pointer-events-none relative size-4 shrink-0 text-zinc-400 transition-transform duration-150 ${
            expanded ? "rotate-90" : ""
          }`}
        />
      </div>
      {expanded ? (
        <div className="border-t gz-divider bg-zinc-900/[0.02] dark:bg-white/[0.02]">
          {children}
        </div>
      ) : null}
    </li>
  );
}
