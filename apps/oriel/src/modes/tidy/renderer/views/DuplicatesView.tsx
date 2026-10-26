import type {
  DuplicateScope,
  DuplicateSet,
  FileId,
  RootId,
} from "@latch-works/glazier-core/contract";
import { CheckCircle2, ChevronLeft, ChevronRight } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, Kbd, Segmented, Spinner, Switch, TopBar } from "../../../../ui/ui";
import { CopyList } from "../components/duplicates/CopyList";
import { Loupe } from "../components/duplicates/Loupe";
import {
  decisionLabel,
  filesOf,
  freedBytes,
  holdingSummary,
  keepEveryLabel,
  keptIds,
  reasonOf,
  removalOf,
  rowsOf,
} from "../components/duplicates/model";
import { SetQueue } from "../components/duplicates/SetQueue";
import { useSetQueue } from "../components/duplicates/use-set-queue";
import { VersionGrid } from "../components/duplicates/VersionGrid";
import { useToastLift, useToasts } from "../components/Toasts";
import { useActions } from "../lib/actions";
import { call, desktop } from "../lib/api";
import { useActiveJob, useEngine } from "../lib/engine-state";
import { formatBytes, formatCount, plural } from "../lib/format";
import { digitOf, isCommandKey, isPlainKey, useViewKeys } from "../lib/hotkeys";
import { useNavigation } from "../lib/navigation";
import { SIMILARITY_LEVELS, usePreferFolder } from "../lib/preferences";

/** How long a click on a new set waits, so a double-click never decides two sets. */
const ARM_DELAY_MS = 400;

/** A request to open on a tab counts only right after it was made, not on a later visit. */
const TAB_REQUEST_MS = 2000;

export function DuplicatesView({ rootId }: { rootId: RootId }) {
  const { settings, setSettings, catalogVersion, report } = useEngine();
  const actions = useActions();
  const toasts = useToasts();
  const navigation = useNavigation();
  const preferFolder = usePreferFolder(rootId);
  const similarJob = useActiveJob("similar", rootId);
  const level = settings?.similarity ?? "balanced";

  // Similar sets need eyes, so they come first, unless Overview asked for identical copies. With
  // no similar sets at all, the first load falls to identical copies; it never switches later.
  const [chosenScope, setChosenScope] = useState<DuplicateScope | null>(() => {
    const request = navigation.duplicatesTab;

    return request && Date.now() - request.at < TAB_REQUEST_MS ? request.tab : null;
  });

  const spotVariants = settings?.spotVariants ?? false;

  // The Variants tab exists only while Spot variants sorts them out.
  const scope: DuplicateScope =
    chosenScope === "variants" && !spotVariants ? "similar" : (chosenScope ?? "similar");

  const [dismissedMode, setDismissedMode] = useState(false);
  const queue = useSetQueue({ rootId, level, scope, dismissed: dismissedMode });
  const [activeIndex, setActiveIndex] = useState(0);
  const [focusedRow, setFocusedRow] = useState(1);
  // The focus is drawn only once the arrow keys move it, so a new set never looks half-picked.
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const [looking, setLooking] = useState(false);
  // The version under the pointer, so P and Space act on what the owner is pointing at.
  const [hoverRow, setHoverRow] = useState<number | null>(null);
  // A click right after a new set appears was aimed at the old one, so it waits this long.
  const armedAt = useRef(0);
  const [zoomed, setZoomed] = useState(false);
  const [playing, setPlaying] = useState(false);
  // Played videos are heard: playing one is how the owner checks its soundtrack. M mutes.
  const [soundOn, setSoundOn] = useState(true);
  const [overrides, setOverrides] = useState<ReadonlyMap<string, FileId[]>>(new Map());
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  // Sets resolved or dismissed here stay hidden until a refresh newer than that change arrives.
  const [hidden, setHidden] = useState<ReadonlyMap<string, number>>(new Map());
  // A set undone from here comes back into focus once the refresh brings it.
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const [freedHere, setFreedHere] = useState(0);
  const versionRef = useRef(catalogVersion);
  // The toast of the last decision, taken down when that decision is undone some other way (⌘Z).
  const decisionToast = useRef<number | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const [zoomAt, setZoomAt] = useState<{ x: number; y: number } | null>(null);

  versionRef.current = catalogVersion;

  const data = queue.data;

  useEffect(() => {
    if (chosenScope === null && data) {
      setChosenScope(data.counts.similar === 0 && data.counts.exact > 0 ? "exact" : "similar");
    }
  }, [chosenScope, data]);

  // The pointer hides the keyboard focus again, and is remembered for zooming in at it.
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      pointer.current = {
        x: event.clientX / window.innerWidth,
        y: event.clientY / window.innerHeight,
      };
      setKeyboardFocus(false);
    };

    window.addEventListener("pointermove", onMove);

    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  const sets = useMemo(
    () =>
      (data?.sets ?? []).filter((set) => {
        const until = hidden.get(set.key);

        return until === undefined || queue.version > until;
      }),
    [data, queue.version, hidden],
  );

  useEffect(() => {
    if (returnTo === null) {
      return;
    }

    const position = sets.findIndex((set) => set.key === returnTo);

    if (position >= 0) {
      setActiveIndex(position);
      setReturnTo(null);
    }
  }, [returnTo, sets]);

  const index = Math.min(activeIndex, Math.max(0, sets.length - 1));
  const active = sets[index] ?? null;
  const rows = useMemo(() => (active ? rowsOf(active) : []), [active]);
  const override = active ? overrides.get(active.key) : undefined;
  const kept = active ? keptIds(active, override) : [];
  const keptSet = new Set(kept);
  const removed = active ? removalOf(active, kept) : [];
  const activeKey = active?.key ?? null;

  // A new set starts with focus on its first version that would go, fitted, paused.
  useEffect(() => {
    if (activeKey !== null) {
      setFocusedRow(1);
      setKeyboardFocus(false);
      setZoomed(false);
      setPlaying(false);
      armedAt.current = Date.now() + ARM_DELAY_MS;
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

  /** Says what a decision did in a toast with its Undo, in place of the last decision's. */
  const announce = useCallback(
    (message: string, detail: string | null, undo: (() => void) | null) => {
      decisionToast.current = toasts.show({
        message,
        detail,
        tone: undo ? "done" : "info",
        action: undo ? { label: "Undo", run: undo } : null,
      });
    },
    [toasts],
  );

  const bringBack = useCallback(
    (key: string) => {
      unhide(key);
      setReturnTo(key);

      if (decisionToast.current !== null) {
        toasts.dismiss(decisionToast.current);
        decisionToast.current = null;
      }
    },
    [toasts, unhide],
  );

  /** Resolves a set keeping `keep`, and says so in a toast with Undo. */
  const resolveWith = useCallback(
    async (set: DuplicateSet, keep: readonly FileId[]) => {
      const going = removalOf(set, keep);

      if (going.length === 0) {
        return;
      }

      const keeper = filesOf(set).find((file) => file.id === keep[0]);
      const bytes = freedBytes(set, going);

      hide(set.key, Number.POSITIVE_INFINITY);

      const plan = await actions.perform(
        {
          kind: "resolve-duplicates",
          groups: [{ keep: [...keep], remove: going.map((file) => file.id) }],
        },
        { quiet: true, onUndone: () => bringBack(set.key) },
      );

      if (!plan) {
        unhide(set.key);

        return;
      }

      // Until a newer refresh, which brings the set back if anything in it stayed.
      hide(set.key, versionRef.current);

      // A file that changed since the scan stays where it is; the engine scans again for it.
      const stayed =
        plan.skipped > 0
          ? `${plural(plan.skipped, "file")} changed since the scan and stayed; Tidy is scanning again`
          : null;

      if (plan.done === 0) {
        // A failure already has its own toast.
        if (plan.failed === 0) {
          announce("Nothing moved", stayed, null);
        }

        return;
      }

      setFreedHere((current) => current + bytes);

      // One kept file is named with its folder; several kept in one set are counted.
      const several = keep.length > 1;

      announce(
        several
          ? `Kept ${set.kind === "exact" ? plural(keep.length, "copy", "copies") : plural(keep.length, "version")}`
          : `Kept ${keeper?.name ?? "1 file"}`,
        stayed ?? (several || !keeper ? null : `In ${keeper.dir || "the top folder"}`),
        () => void actions.undoPlan(plan, { quiet: true, onUndone: () => bringBack(set.key) }),
      );
    },
    [actions, announce, bringBack, hide, unhide],
  );

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
        bringBack(set.key);
      };

      const forget = actions.pushUndo(restore);

      announce(set.kind === "exact" ? "Kept every copy" : "Marked as not duplicates", null, () => {
        forget();
        void restore().catch(report);
      });
    } catch (error) {
      unhide(set.key);
      report(error);
    }
  }, [active, actions, announce, bringBack, hide, report, unhide]);

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

  /** Return: the current keepers, or "keep every version" when all are kept. */
  const decide = useCallback(() => {
    if (!active) {
      return;
    }

    if (dismissedMode) {
      void restoreDismissed();
    } else if (removed.length > 0) {
      void resolveWith(active, kept);
    } else {
      void dismiss();
    }
  }, [active, dismiss, dismissedMode, kept, removed.length, resolveWith, restoreDismissed]);

  /** A number key or a click on a version: keeps only that one, resolves and moves on. */
  const keepOnly = (rowIndex: number) => {
    const row = rows[rowIndex];

    if (active && row && !dismissedMode) {
      void resolveWith(active, [row.file.id]);
    }
  };

  /** A click keeps like its number key does, unless the set only just appeared under it. */
  const clickKeep = (rowIndex: number) => {
    if (Date.now() >= armedAt.current) {
      keepOnly(rowIndex);
    }
  };

  const toggleKeep = (rowIndex: number) => {
    const row = rows[rowIndex];

    if (!active || !row || dismissedMode) {
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

  const focusBy = (delta: number) => {
    setFocusedRow(Math.max(0, Math.min(rows.length - 1, focus + delta)));
    setKeyboardFocus(true);
  };

  const hasVideo = rows.some((row) => row.file.kind === "video");
  const similarSet = active?.kind === "similar";

  const keeperRow = Math.max(
    0,
    rows.findIndex((row) => keptSet.has(row.file.id)),
  );

  /**
   * The version a key acts on: the keyboard focus once the arrows moved it, else the one under
   * the pointer, else the suggestion (never a focus the owner cannot see).
   */
  const target = keyboardFocus ? focus : (hoverRow ?? keeperRow);

  const openLoupe = (rowIndex: number) => {
    setFocusedRow(rowIndex);
    setZoomed(false);
    setLooking(true);
  };

  useViewKeys((event) => {
    // A held key repeats; a decision never should.
    const deciding = digitOf(event) !== null || ["Enter", "n", "N", "s", "S"].includes(event.key);

    if (event.repeat && deciding) {
      return true;
    }

    if (isCommandKey(event) && event.shiftKey && (event.key === "r" || event.key === "R")) {
      const row = rows[looking ? focus : target];

      if (row) {
        void desktop.reveal(row.file.absPath);
      }

      return true;
    }

    if (isCommandKey(event) && (event.key === "y" || event.key === "Y")) {
      const row = rows[looking ? focus : target];

      if (row) {
        void desktop.quickLook(row.file.absPath);
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
          setFocusedRow(digit - 1);
        } else {
          keepOnly(digit - 1);
        }
      }

      return true;
    }

    if (!isPlainKey(event)) {
      return false;
    }

    switch (event.key) {
      case "ArrowDown":
      case "j":
      case "J":
        move(1);

        return true;
      case "ArrowUp":
      case "k":
      case "K":
        move(-1);

        return true;
      case "ArrowRight":
      case "l":
        focusBy(1);

        return true;
      case "ArrowLeft":
      case "h":
        focusBy(-1);

        return true;
      case "Enter":
        // In the loupe, Return keeps the version on screen.
        if (looking) {
          keepOnly(focus);
        } else {
          decide();
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
        const row = rows[looking ? focus : target];

        if (row && !dismissedMode) {
          void preferFolder(row.file.dir);
        }

        return true;
      }

      case "c":
      case "C":
        if (similarSet) {
          if (looking) {
            setLooking(false);
          } else {
            openLoupe(target);
          }
        }

        return true;
      case "z":
      case "Z":
        if (similarSet) {
          if (!looking) {
            setFocusedRow(target);
          }

          setZoomAt(pointer.current);
          setLooking(true);
          setZoomed((current) => !looking || !current);
        }

        return true;
      case "m":
      case "M":
        setSoundOn((current) => !current);

        return true;
      case " ": {
        // Space looks closer, as in Finder, without deciding anything; in the loupe it plays.
        if (looking && hasVideo) {
          setPlaying((current) => !current);
        } else if (similarSet && !looking) {
          openLoupe(target);
        } else if (!similarSet) {
          const row = rows[target];

          if (row) {
            void desktop.quickLook(row.file.absPath);
          }
        }

        return true;
      }

      case "Escape":
        if (looking) {
          setLooking(false);
          setZoomed(false);

          return true;
        }

        return false;
      default:
        return false;
    }
  });

  const fingerprinting = data !== null && data.fingerprinted < data.fingerprintable;
  const comparing = data !== null && data.compared < data.comparable;
  const otherScope: DuplicateScope = scope === "similar" ? "exact" : "similar";
  const otherCount = data ? (scope === "similar" ? data.counts.exact : data.counts.similar) : 0;

  const changeScope = (next: DuplicateScope) => {
    setChosenScope(next);
    setActiveIndex(0);
    setLooking(false);
  };

  const showDismissed = (next: boolean) => {
    setDismissedMode(next);
    setActiveIndex(0);
    setLooking(false);
  };

  useToastLift(active ? 72 : 0);

  const reason = active ? reasonOf(active, rows, kept, override !== undefined) : null;
  const closeCall = reason?.closeCall ?? false;

  const scopeSwitch =
    data && !dismissedMode ? (
      <Segmented
        label="Show"
        fill
        value={scope}
        onChange={changeScope}
        options={[
          { value: "similar", label: "Similar", count: data.counts.similar },
          ...(spotVariants
            ? [{ value: "variants" as const, label: "Variants", count: data.counts.variants }]
            : []),
          { value: "exact", label: "Identical", count: data.counts.exact },
        ]}
      />
    ) : null;

  const decisionBar = active ? (
    <div className="lw-float absolute bottom-5 left-1/2 z-10 flex w-max max-w-[calc(100%-40px)] -translate-x-1/2 items-center gap-2 p-1.5">
      {dismissedMode ? (
        <>
          <span className="lw-caption px-3">You marked these as not duplicates</span>
          <button
            type="button"
            className="lw-btn lw-btn-primary lw-btn-lg"
            onClick={() => void restoreDismissed()}
          >
            Restore <Kbd>↩</Kbd>
          </button>
        </>
      ) : (
        <>
          {looking ? (
            <>
              <button
                type="button"
                className="lw-btn lw-btn-ghost lw-btn-icon size-9"
                title="Previous version  ←"
                aria-label="Previous version"
                disabled={focus === 0}
                onClick={() => focusBy(-1)}
              >
                <ChevronLeft />
              </button>
              <button
                type="button"
                className="lw-btn lw-btn-ghost lw-btn-icon size-9"
                title="Next version  →"
                aria-label="Next version"
                disabled={focus >= rows.length - 1}
                onClick={() => focusBy(1)}
              >
                <ChevronRight />
              </button>
              <span className="mx-1 h-5 w-px bg-zinc-200 dark:bg-white/10" aria-hidden />
            </>
          ) : null}
          <button
            type="button"
            className="lw-btn lw-btn-secondary lw-btn-lg"
            title="Skip for now  S"
            onClick={skip}
          >
            Skip
          </button>
          {removed.length > 0 ? (
            <button
              type="button"
              className="lw-btn lw-btn-secondary lw-btn-lg"
              title={`Keep every ${active.kind === "exact" ? "copy" : "version"} and stop showing this set  N`}
              onClick={() => void dismiss()}
            >
              {keepEveryLabel(active, rows)}
            </button>
          ) : null}
          {/* In the loupe the primary keeps the version on screen; elsewhere, the keepers. */}
          <button
            type="button"
            className="lw-btn lw-btn-primary lw-btn-lg"
            title={
              looking ? `Keep only ${focus + 1} and go on` : holdingSummary(active, rows, keptSet)
            }
            data-decide
            onClick={() => (looking ? keepOnly(focus) : decide())}
          >
            {looking ? `Keep ${focus + 1}` : decisionLabel(active, rows, keptSet)} <Kbd>↩</Kbd>
          </button>
        </>
      )}
    </div>
  ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar
        title={dismissedMode ? "Not duplicates" : "Duplicates"}
        meta={
          fingerprinting ? (
            <AnalysisNote
              running={similarJob !== null}
              title="Similar versions appear as each picture and video is checked"
            >
              Checking {formatCount(data?.fingerprinted ?? 0)} of{" "}
              {formatCount(data?.fingerprintable ?? 0)}
            </AnalysisNote>
          ) : comparing ? (
            <AnalysisNote
              running={similarJob !== null}
              title="Spot variants compares each similar picture with the rest of its set"
            >
              {/* Sets are rebuilt when the job ends, so the running job counts what is left. */}
              Comparing{" "}
              {similarJob?.state === "running" && similarJob.total > 0
                ? `${formatCount(similarJob.done)} of ${formatCount(similarJob.total)}`
                : `${formatCount(data?.compared ?? 0)} of ${formatCount(data?.comparable ?? 0)}`}
            </AnalysisNote>
          ) : null
        }
      >
        <Segmented
          label="Similar versions"
          options={SIMILARITY_LEVELS}
          value={level}
          onChange={(similarity) => {
            if (settings) {
              void setSettings({ ...settings, similarity });
            }
          }}
        />
        <span
          className="flex items-center gap-2 text-[13px] text-zinc-700 dark:text-zinc-300"
          title="Keeps every picture that differs in one area (a face, an outfit, a caption's language), and keeps each picture's copy with sound, the most pixels, or in the folder holding the rest of its set"
        >
          Spot variants
          <Switch
            label="Spot variants"
            checked={spotVariants}
            onChange={(next) => {
              if (settings) {
                void setSettings({ ...settings, spotVariants: next });
              }
            }}
          />
        </span>
        <button
          type="button"
          className="lw-btn lw-btn-secondary aria-pressed:bg-zinc-900/[0.06] dark:aria-pressed:bg-white/[0.12]"
          aria-pressed={dismissedMode}
          title={dismissedMode ? "Back to the sets to review" : "Sets you marked as not duplicates"}
          onClick={() => showDismissed(!dismissedMode)}
        >
          Not duplicates
          {data ? (
            <span className="text-xs text-zinc-400 dark:text-zinc-500">
              {formatCount(data.counts.dismissed)}
            </span>
          ) : null}
        </button>
      </TopBar>

      {data === null ? (
        <EmptyState title="Finding duplicates…" />
      ) : sets.length === 0 ? (
        <div className="flex min-h-0 flex-1">
          {scopeSwitch ? (
            <aside className="w-[232px] shrink-0 border-r lw-divider px-3 pt-3 xl:w-[264px]">
              {scopeSwitch}
            </aside>
          ) : null}
          <EmptyState
            icon={CheckCircle2}
            title={
              dismissedMode
                ? "Nothing marked as not duplicates"
                : scope === "variants"
                  ? comparing
                    ? "No variants found yet"
                    : "No sets of variants"
                  : scope === "similar"
                    ? freedHere > 0
                      ? "All similar sets done"
                      : fingerprinting
                        ? "No similar versions found yet"
                        : "No similar versions"
                    : "No identical copies"
            }
            actions={
              dismissedMode ? null : (
                <>
                  <button
                    type="button"
                    className="lw-btn lw-btn-secondary"
                    onClick={() => navigation.go("overview")}
                  >
                    Back to Overview
                  </button>
                  {otherCount > 0 ? (
                    <button
                      type="button"
                      className="lw-btn lw-btn-secondary"
                      onClick={() => changeScope(otherScope)}
                    >
                      {otherScope === "exact" ? "Show identical copies" : "Show similar versions"}
                    </button>
                  ) : null}
                </>
              )
            }
          >
            {freedHere > 0
              ? `${formatBytes(freedHere)} moved to holding.`
              : fingerprinting && scope === "similar" && !dismissedMode
                ? `Still checking for similar versions: ${formatCount(data.fingerprinted)} of ${formatCount(data.fingerprintable)}.`
                : scope === "variants" && !dismissedMode
                  ? "Similar sets whose pictures each differ in one area come here, since none of them is a copy."
                  : null}
          </EmptyState>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <SetQueue
            sets={sets}
            total={Math.max(sets.length, data.total - (data.sets.length - sets.length))}
            activeIndex={index}
            skipped={skipped}
            overrides={overrides}
            header={scopeSwitch}
            onSelect={(position) => {
              setActiveIndex(position);
              setLooking(false);
            }}
            onNearEnd={queue.loadMore}
          />

          {active ? (
            <section
              className="relative flex min-h-0 min-w-0 flex-1 flex-col"
              data-set-key={active.key}
              data-set-kind={active.kind}
            >
              {active.kind === "exact" ? (
                <CopyList
                  rows={rows}
                  kept={keptSet}
                  keepReason={reason?.text ?? null}
                  focus={focus}
                  showFocus={keyboardFocus}
                  readOnly={dismissedMode}
                  onHover={setHoverRow}
                  onKeepOnly={clickKeep}
                  onToggleKeep={toggleKeep}
                />
              ) : (
                <VersionGrid
                  set={active}
                  rows={rows}
                  kept={keptSet}
                  keepReason={reason?.text ?? null}
                  closeCall={closeCall}
                  focus={focus}
                  showFocus={keyboardFocus}
                  readOnly={dismissedMode}
                  onHover={setHoverRow}
                  onLook={openLoupe}
                  onKeepOnly={clickKeep}
                  onToggleKeep={toggleKeep}
                />
              )}

              {looking && similarSet ? (
                <Loupe
                  rows={rows}
                  index={focus}
                  kept={keptSet}
                  closeCall={closeCall}
                  suggested={keeperRow + 1}
                  zoomed={zoomed}
                  playing={playing}
                  soundOn={soundOn}
                  pointer={zoomAt}
                  onClose={() => {
                    setLooking(false);
                    setZoomed(false);
                  }}
                  onToggleZoom={(at) => {
                    setZoomAt(at);
                    setZoomed((current) => !current);
                  }}
                >
                  {decisionBar}
                </Loupe>
              ) : (
                decisionBar
              )}
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Analysis still running, beside the title: a spinner while its job runs, and how far it got. */
function AnalysisNote({
  running,
  title,
  children,
}: {
  running: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-2" title={title}>
      {running ? <Spinner /> : null}
      {children}
    </span>
  );
}
