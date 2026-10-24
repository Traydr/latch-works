import type {
  FindingKind,
  Job,
  PlanKind,
  PlanRequest,
  PlanSummary,
  RootId,
  Tidy,
} from "@latch-works/glazier-core/contract";
import {
  Archive,
  Check,
  ChevronRight,
  Copy,
  FolderOpen,
  FolderUp,
  Images,
  RefreshCw,
  Repeat2,
  Sparkles,
  VolumeX,
} from "lucide-react";
import { type ComponentType, type ReactNode, useRef, useState } from "react";
import { useShell } from "../../../../shell/shell";
import { EmptyState, Kbd, ProgressBar, Spinner, TopBar } from "../../../../ui/ui";
import { Poster } from "../components/tidy/MediaTile";
import { jobCount, RunProgress } from "../components/tidy/RunProgress";
import { silentVideoIds, tidyUpSteps } from "../components/tidy/requests";
import { useActions } from "../lib/actions";
import { call } from "../lib/api";
import {
  CONVERT_GROUPS,
  describeEstimate,
  groupTotals,
  useConvertEstimates,
  useConvertGroups,
} from "../lib/convert-options";
import { useActiveJob, useEngine, useEngineQuery } from "../lib/engine-state";
import { formatBytes, formatCount, formatRelative, plural } from "../lib/format";
import { useOpenInView } from "../lib/hand-off";
import { isCommandKey, isPlainKey, useNow, useViewKeys } from "../lib/hotkeys";
import { type LibraryPreset, useNavigation } from "../lib/navigation";

const TIDY_SOURCE = "overview:tidy";

/** Up to this many keepers stand for the similar sets on the Needs your eye card. */
const STACK = 5;

type StepId = "convert" | "silent" | "cleanup";

type StepState = "todo" | "running" | "done";

/** Which hero row a plan Tidy up runs belongs to. */
const STEP_OF_KIND: Partial<Record<PlanKind, StepId>> = {
  cleanup: "cleanup",
  "strip-audio": "silent",
  optimize: "convert",
};

/** What a scan finds that needs a look, and the Library filter that shows it. */
const ATTENTION = {
  undecodable: {
    label: (count: number) => `${plural(count, "file")} won't open`,
    preset: { flags: ["undecodable"] },
  },
  "zero-byte": {
    label: (count: number) => plural(count, "empty file"),
    preset: { flags: ["zero-byte"] },
  },
  unsupported: {
    label: (count: number) => `${plural(count, "file")} no Latch Works app shows`,
    preset: { flags: ["unsupported"] },
  },
  "presigned-delivery": {
    label: (count: number) => `${formatCount(count)} Pane serves without resizing (MKV, BMP)`,
    preset: { formats: ["matroska", "bmp"] },
  },
  "unconvertible-video": {
    label: (count: number) => `${formatCount(count)} can't become MP4 (AVI, FLV, WMV)`,
    preset: { formats: ["avi", "flv", "asf"] },
  },
} as const satisfies Record<
  FindingKind,
  { label: (count: number) => string; preset: Partial<LibraryPreset> }
>;

const LINK =
  "underline decoration-zinc-300 underline-offset-2 hover:text-zinc-900 dark:decoration-zinc-600 dark:hover:text-zinc-100";

function joinParts(parts: ReadonlyArray<string | false>): string {
  return parts.flatMap((part) => (part ? [part] : [])).join(" · ");
}

interface Step {
  id: StepId;
  icon: ComponentType<{ className?: string }>;
  title: string;
  caption: string;
  /** Whether there is work for this row now. */
  todo: boolean;
  /** Opens the page that shows this row's files. */
  open: () => void;
  action: string;
  run: () => Promise<PlanSummary | null>;
}

export function OverviewView({ rootId }: { rootId: RootId }) {
  const tidy = useEngineQuery("tidy", { rootId });
  const scan = useActiveJob("scan", rootId);
  const { roots, report } = useEngine();
  const { openDuplicates } = useNavigation();
  const now = useNow();
  const root = roots.find((candidate) => candidate.id === rootId);
  const { handOff } = useShell();
  const openInView = useOpenInView();

  useViewKeys((event) => {
    if (isPlainKey(event) && event.key.toLowerCase() === "d") {
      openDuplicates("similar");

      return true;
    }

    return false;
  });

  const data = tidy.data;

  const rescan = (
    <>
      {root ? (
        <>
          <button
            type="button"
            className="lw-btn lw-btn-ghost"
            title="Open this folder in View"
            onClick={() => openInView(root.path, "folder")}
          >
            <Images />
            Open in View
          </button>
          <button
            type="button"
            className="lw-btn lw-btn-ghost"
            title="Push this folder to Pane View with Sync"
            onClick={() => void handOff("sync", { kind: "folder", path: root.path })}
          >
            <FolderUp />
            Sync this folder
          </button>
        </>
      ) : null}
      <button
        type="button"
        className="lw-btn lw-btn-ghost lw-btn-icon"
        aria-label="Rescan"
        title="Rescan  ⌘R"
        disabled={scan !== null}
        onClick={() => void call("scanRoot", { rootId }).catch(report)}
      >
        {scan ? <Spinner /> : <RefreshCw />}
      </button>
    </>
  );

  // The first scan: nothing catalogued yet to show.
  const firstScan =
    scan !== null
      ? root?.lastScanAt === null || !data || data.files === 0
      : root?.lastScanAt === null && !data?.files;

  if (firstScan) {
    return (
      <>
        <TopBar title="Overview">{rescan}</TopBar>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 pb-[100px]">
          <p className="text-[15px] font-semibold">Scanning {root?.name ?? "the folder"}</p>
          <div className="w-[320px]">
            <ProgressBar ratio={scan && scan.total > 0 ? scan.done / scan.total : null} />
          </div>
          <p className="lw-caption">{plural(scan?.done ?? 0, "file")} found</p>
        </div>
      </>
    );
  }

  if (!data) {
    return (
      <>
        <TopBar title="Overview">{rescan}</TopBar>
        {tidy.error ? <EmptyState title={tidy.error} /> : <div className="flex-1" />}
      </>
    );
  }

  return (
    <>
      <TopBar
        title="Overview"
        meta={joinParts([
          plural(data.files, "file"),
          formatBytes(data.bytes),
          scan ? "scanning" : `scanned ${formatRelative(data.lastScanAt, now)}`,
        ])}
      >
        {rescan}
      </TopBar>
      {data.files === 0 ? (
        <EmptyState icon={FolderOpen} title="This folder is empty" />
      ) : (
        <OverviewBody rootId={rootId} rootName={root?.name ?? "the folder"} data={data} />
      )}
    </>
  );
}

function OverviewBody({
  rootId,
  rootName,
  data,
}: {
  rootId: RootId;
  rootName: string;
  data: Tidy;
}) {
  const { report, jobs } = useEngine();
  const actions = useActions();
  const { go } = useNavigation();
  const { enabled } = useConvertGroups();
  const { estimate } = useConvertEstimates(rootId, data);
  const listRef = useRef<HTMLUListElement>(null);

  // Rows started this visit stay listed, as done once their work is, until the hero card goes.
  const [started, setStarted] = useState<{ rootId: RootId; steps: ReadonlySet<StepId> }>({
    rootId,
    steps: new Set(),
  });

  // What the last Tidy up this visit took out of the folder, for the done card.
  const [saved, setSaved] = useState<{ rootId: RootId; bytes: number } | null>(null);

  const [preparing, setPreparing] = useState(false);
  const similarJob = useActiveJob("similar", rootId);
  const soundJob = useActiveJob("sound", rootId);
  const tidyJob = actions.jobFor(TIDY_SOURCE);
  const tidyPlan = useEngineQuery("getPlan", tidyJob?.planId ? { planId: tidyJob.planId } : null);
  const tidying = preparing || tidyJob !== null;
  const tidyStep = tidyJob && tidyPlan.data ? STEP_OF_KIND[tidyPlan.data.kind] : undefined;
  const kept = started.rootId === rootId ? started.steps : new Set<StepId>();

  const keep = (steps: readonly StepId[]) =>
    setStarted((current) => ({
      rootId,
      steps: new Set([...(current.rootId === rootId ? current.steps : []), ...steps]),
    }));

  const runOne = (id: StepId, request: PlanRequest) => {
    keep([id]);

    return actions.perform(request, { source: `overview:${id}` });
  };

  // Convert
  const chosen = CONVERT_GROUPS.filter((group) => enabled.has(group.id));
  const categories = chosen.flatMap((group) => [...group.categories]);
  const convertFiles = chosen.reduce((sum, group) => sum + groupTotals(data, group).files, 0);
  const convertBytes = chosen.reduce((sum, group) => sum + groupTotals(data, group).bytes, 0);
  const convertEstimate = estimate(categories);

  // Clean up
  const { junk, emptyFolders, extensions } = data.cleanup;
  const { exact, similar } = data.duplicates;

  // In the order Tidy up runs them, so its done checks fill from the top.
  const steps: Step[] = [
    {
      id: "cleanup",
      icon: Sparkles,
      title: "Junk and empty folders",
      caption: joinParts([
        junk > 0 && plural(junk, "junk file"),
        emptyFolders > 0 && plural(emptyFolders, "empty folder"),
        extensions > 0 && plural(extensions, "wrong extension"),
      ]),
      todo: junk + emptyFolders + extensions > 0,
      open: () => go("cleanup"),
      action: "Clean up",
      run: () => runOne("cleanup", { kind: "cleanup", rootId }),
    },
    {
      id: "silent",
      icon: VolumeX,
      title: "Silent soundtracks",
      caption: plural(data.silentTracks.files, "video"),
      todo: data.silentTracks.files > 0,
      open: () => go("cleanup"),
      action: "Remove sound",
      run: async () => {
        const ids = await silentVideoIds(rootId);

        return ids.length > 0 ? runOne("silent", { kind: "strip-audio", fileIds: ids }) : null;
      },
    },
    {
      id: "convert",
      icon: Repeat2,
      title: "Convert to AVIF and MP4",
      caption: `${plural(convertFiles, "file")} · ${describeEstimate(convertBytes, convertEstimate)}`,
      todo: convertFiles > 0,
      open: () => go("convert"),
      action: "Convert",
      run: () => runOne("convert", { kind: "optimize", rootId, categories, fileIds: null }),
    },
  ];

  const stateOf = (step: Step): StepState =>
    actions.jobFor(`overview:${step.id}`) !== null || tidyStep === step.id
      ? "running"
      : step.todo
        ? "todo"
        : "done";

  const work = steps.some((step) => step.todo) || tidying;

  const shown = steps.filter(
    (step) => step.todo || kept.has(step.id) || stateOf(step) === "running",
  );

  // What tidying saves: what conversion is estimated to save. Duplicates are decided by hand.
  const saving =
    convertFiles > 0 && convertEstimate.state === "known"
      ? Math.max(0, convertEstimate.before - convertEstimate.after)
      : 0;

  // Until Convert's estimate lands, the headline is a floor, so it never jumps up.
  const estimating = convertFiles > 0 && convertEstimate.state === "pending";

  const tidyUp = async () => {
    setPreparing(true);
    keep(steps.flatMap((step) => (step.todo ? [step.id] : [])));

    try {
      const steps = tidyUpSteps(rootId, data, categories);

      if (steps.length > 0) {
        const plans = await actions.performAll(steps, {
          title: `Tidied up ${rootName}`,
          source: TIDY_SOURCE,
        });

        const bytes = plans.reduce((sum, plan) => sum + plan.bytesBefore - plan.bytesAfter, 0);

        setSaved({ rootId, bytes });
      }
    } catch (error) {
      report(error);
    } finally {
      setPreparing(false);
    }
  };

  useViewKeys((event) => {
    if (isCommandKey(event) && event.key === "Enter") {
      if (!work || tidying) {
        return false;
      }

      void tidyUp();

      return true;
    }

    if (!isPlainKey(event)) {
      return false;
    }

    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-step-link]") ?? [])];
    // A row's own action button counts as that row.
    const at = rows.findIndex((row) => row.parentElement?.contains(document.activeElement));

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (rows.length === 0) {
        return false;
      }

      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = at === -1 ? (step > 0 ? 0 : rows.length - 1) : at + step;

      rows[Math.min(rows.length - 1, Math.max(0, next))]?.focus();

      return true;
    }

    // Return on a focused row is the button's own click.
    if (event.key === "ArrowRight" && at !== -1) {
      rows[at]?.click();

      return true;
    }

    return false;
  });

  const looking = data.analysis.fingerprinted < data.analysis.fingerprintable;

  // Checking waits behind other work, so it is only offered while nothing runs.
  const unchecked =
    !tidying &&
    jobs.every((job) => job.state !== "running" && job.state !== "queued") &&
    ((looking && similarJob === null) ||
      (data.analysis.soundMeasured < data.analysis.soundMeasurable && soundJob === null));

  const lookCard = similar.sets > 0 || looking || unchecked;
  const savedBytes = saved?.rootId === rootId ? saved.bytes : 0;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-6 pt-6 pb-28">
        {work ? (
          <section className="lw-card p-5">
            <div className="flex items-end gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-zinc-500">
                  {tidying ? "Tidying up" : saving > 0 ? "Tidying up saves" : "Ready to tidy"}
                </p>
                <p className="lw-display mt-1 flex items-center gap-2.5">
                  {tidying
                    ? `${plural(
                        steps.filter((step) => stateOf(step) === "done").length,
                        "step",
                      )} of ${steps.length} done`
                    : saving > 0
                      ? `${estimating ? "At least" : "About"} ${formatBytes(saving)}`
                      : `${plural(steps.filter((step) => step.todo).length, "thing")} to do`}
                  {!tidying && saving > 0 && estimating ? <Spinner /> : null}
                </p>
                <p className="lw-caption mt-1.5">
                  Everything goes to holding first and can be undone.
                </p>
              </div>
              {tidying ? (
                <RunProgress
                  job={tidyJob}
                  pausable={false}
                  label={
                    tidyJob
                      ? `${tidyJob.label.split(" ")[0] ?? "Working"} ${jobCount(tidyJob)}`
                      : "Starting"
                  }
                />
              ) : (
                <button
                  type="button"
                  className="lw-btn lw-btn-primary lw-btn-lg"
                  onClick={() => void tidyUp()}
                >
                  Tidy up <Kbd>⌘↩</Kbd>
                </button>
              )}
            </div>
            <ul className="mt-5" ref={listRef}>
              {shown.map((step) => (
                <StepRow key={step.id} step={step} state={stateOf(step)} busy={tidying} />
              ))}
            </ul>
          </section>
        ) : (
          <section className="lw-card flex h-16 items-center gap-3 px-5" data-step="tidy">
            <Check className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <div className="min-w-0">
              <p className="lw-heading">Tidy</p>
              <p className="lw-caption truncate">
                {savedBytes > 0
                  ? `${formatBytes(savedBytes)} out of ${rootName} · in holding until you empty it`
                  : "Nothing left to tidy"}
              </p>
            </div>
          </section>
        )}

        {lookCard ? (
          <LookCard
            rootId={rootId}
            data={data}
            similarJob={similarJob}
            soundJob={soundJob}
            unchecked={unchecked}
          />
        ) : null}

        {exact.sets > 0 ? <IdenticalCard data={data} /> : null}

        <HoldingRow rootId={rootId} />
        <AttentionLine data={data} />
      </div>
    </div>
  );
}

/** The tile an Overview row's icon sits on. */
const ROW_ICON =
  "flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-900/[0.05] dark:bg-white/[0.07]";

const ROW_BUTTON = "lw-hover lw-focus flex h-[52px] items-center gap-3 rounded-lg px-2 text-left";

function StepRow({ step, state, busy }: { step: Step; state: StepState; busy: boolean }) {
  const { report } = useEngine();
  const Icon = state === "done" ? Check : step.icon;

  return (
    <li
      data-step={step.id}
      data-state={state}
      className="group relative border-t lw-divider first:border-t-0"
    >
      <button
        type="button"
        data-step-link
        onClick={step.open}
        className={`${ROW_BUTTON} -mx-2 w-[calc(100%+16px)]`}
      >
        <span
          className={`${ROW_ICON} ${state === "done" ? "text-emerald-600 dark:text-emerald-400" : ""}`}
        >
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={`block text-[13px] font-medium ${state === "done" ? "text-zinc-500" : ""}`}
          >
            {step.title}
          </span>
          <span className="lw-caption block truncate">
            {state === "done" ? "Done" : step.caption}
          </span>
        </span>
        {state === "todo" ? <span className="w-28 shrink-0" /> : null}
        {state === "running" ? (
          <Spinner />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-zinc-400" />
        )}
      </button>
      {state === "todo" && !busy ? (
        <button
          type="button"
          className="lw-btn lw-btn-ghost lw-btn-sm absolute top-1/2 right-7 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100"
          onClick={() => void step.run().catch(report)}
        >
          {step.action}
        </button>
      ) : null}
    </li>
  );
}

/** Similar versions need a person; this card points at them, and starts checking if it waits. */
function LookCard({
  rootId,
  data,
  similarJob,
  soundJob,
  unchecked,
}: {
  rootId: RootId;
  data: Tidy;
  similarJob: Job | null;
  soundJob: Job | null;
  /** An analysis has files left and is not running, so it needs starting. */
  unchecked: boolean;
}) {
  const { settings, report } = useEngine();
  const { openDuplicates } = useNavigation();
  const level = settings?.similarity ?? "balanced";
  const { similar } = data.duplicates;
  const { fingerprinted, fingerprintable, soundMeasured, soundMeasurable } = data.analysis;

  const page = useEngineQuery(
    "duplicateSets",
    similar.sets > 0
      ? { rootId, level, scope: "similar", dismissed: false, offset: 0, limit: STACK }
      : null,
  );

  const keepers = (page.data?.sets ?? []).flatMap((set) => {
    const files = set.versions.flatMap((version) => version.files);
    const keeper = files.find((file) => set.keep.includes(file.id)) ?? files[0];

    return keeper ? [keeper] : [];
  });

  const looking = fingerprinted < fingerprintable;

  const checkNow = () => {
    if (looking && similarJob === null) {
      void call("analyzeSimilar", { rootId }).catch(report);
    }

    if (soundMeasured < soundMeasurable && soundJob === null) {
      void call("analyzeSound", { rootId }).catch(report);
    }
  };

  const setsLine = `${plural(similar.sets, "set", "sets")} of similar versions`;
  const bytesLine = `up to ${formatBytes(similar.reclaimableBytes)}`;

  let title: ReactNode;
  let caption: ReactNode = null;

  if (looking && similarJob) {
    title = (
      <span className="inline-flex items-center gap-2">
        <Spinner />
        Still looking for similar versions · {formatCount(fingerprinted)} of{" "}
        {formatCount(fingerprintable)} checked
      </span>
    );

    caption = similar.sets > 0 ? `${setsLine} so far · ${bytesLine}` : null;
  } else if (similar.sets > 0) {
    title = `${setsLine} · ${bytesLine}`;
    caption = unchecked ? "Some files are not checked yet." : null;
  } else {
    title = looking
      ? "Not checked for similar versions yet"
      : "Not checked for silent soundtracks yet";
    caption = looking
      ? `${formatCount(fingerprinted)} of ${formatCount(fingerprintable)} checked`
      : `${formatCount(soundMeasured)} of ${formatCount(soundMeasurable)} measured`;
  }

  return (
    <section className="lw-card flex items-center gap-4 p-4" data-step="similar">
      {keepers.length > 0 ? (
        <div className="flex shrink-0 pl-3">
          {keepers.map((file) => (
            <Poster
              key={file.id}
              row={file}
              size={96}
              className="-ml-3 size-12 rounded-lg ring-2 ring-white dark:ring-zinc-900"
            />
          ))}
        </div>
      ) : null}
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">{title}</p>
        {caption ? <p className="lw-caption mt-0.5">{caption}</p> : null}
      </div>
      {unchecked ? (
        <button type="button" className="lw-btn lw-btn-secondary" onClick={checkNow}>
          Check now
        </button>
      ) : null}
      {similar.sets > 0 ? (
        <button
          type="button"
          className="lw-btn lw-btn-secondary"
          title="Review  D"
          onClick={() => openDuplicates("similar")}
        >
          Review
        </button>
      ) : null}
    </section>
  );
}

/**
 * Identical copies wait for the owner like similar versions do: which copy to keep depends on
 * where each one is, so Tidy up leaves them and this card opens them in Duplicates.
 */
function IdenticalCard({ data }: { data: Tidy }) {
  const { openDuplicates } = useNavigation();
  const { exact } = data.duplicates;

  return (
    <section className="lw-card flex items-center gap-4 p-4" data-step="identical">
      <span className={ROW_ICON}>
        <Copy className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">
          {plural(exact.sets, "set")} of identical copies · {formatBytes(exact.reclaimableBytes)}
        </p>
        <p className="lw-caption mt-0.5">Choose which folders keep each one</p>
      </div>
      <button
        type="button"
        className="lw-btn lw-btn-secondary"
        onClick={() => openDuplicates("exact")}
      >
        Review
      </button>
    </section>
  );
}

/** Held files take space until holding is emptied; this row says so and opens Holding. */
function HoldingRow({ rootId }: { rootId: RootId }) {
  const { go } = useNavigation();
  const holding = useEngineQuery("listHolding", { rootId, offset: 0, limit: 1 });
  const held = holding.data;

  if (!held || held.total === 0) {
    return null;
  }

  return (
    <section className="lw-card px-3 py-1.5" data-step="holding">
      <button type="button" onClick={() => go("holding")} className={`${ROW_BUTTON} w-full`}>
        <span className={ROW_ICON}>
          <Archive className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">
            Holding · {plural(held.total, "file")} · {formatBytes(held.totalBytes)}
          </span>
          <span className="lw-caption block truncate">The space comes back when you empty it</span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-zinc-400" />
      </button>
    </section>
  );
}

function AttentionLine({ data }: { data: Tidy }) {
  const { openLibrary } = useNavigation();
  const findings = data.attention.filter((finding) => finding.count > 0);

  if (findings.length === 0) {
    return null;
  }

  return (
    <p className="lw-caption px-1 leading-5" data-step="attention">
      Also found:{" "}
      {findings.map((finding, index) => (
        <span key={finding.kind}>
          {index > 0 ? " · " : null}
          <button
            type="button"
            data-finding={finding.kind}
            className={LINK}
            onClick={() => openLibrary(ATTENTION[finding.kind].preset)}
          >
            {ATTENTION[finding.kind].label(finding.count)}
          </button>
        </span>
      ))}
    </p>
  );
}
