import type {
  FindingKind,
  Job,
  OptimizeCategory,
  PlanSummary,
  RootId,
  Tidy,
} from "@latch-works/glazier-core/contract";
import { Check, Pause, Play, RefreshCw, Square } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import {
  Dropdown,
  EmptyState,
  Kbd,
  MenuCheck,
  ProgressBar,
  Spinner,
  ViewHeader,
} from "../components/ui";
import { canUndo, describePlan, useActions } from "../lib/actions";
import { call } from "../lib/api";
import { useActiveJob, useEngine, useEngineQuery } from "../lib/engine-state";
import { formatBytes, formatCount, plural } from "../lib/format";
import { isPlainKey, useViewKeys } from "../lib/hotkeys";
import { type LibraryPreset, useNavigation } from "../lib/navigation";

/** The Convert step's three switches; videos cover both lossless and re-encoded moves to MP4. */
const CONVERT_GROUPS = [
  { id: "pictures", label: "Pictures → AVIF", categories: ["still-to-avif"] },
  { id: "animations", label: "Animations → MP4", categories: ["animation-to-mp4"] },
  { id: "videos", label: "Videos → MP4", categories: ["video-remux", "video-convert"] },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  categories: readonly OptimizeCategory[];
}>;

type ConvertGroup = (typeof CONVERT_GROUPS)[number]["id"];

const GROUP_NOUNS = {
  pictures: ["picture", "pictures", "AVIF"],
  animations: ["animation", "animations", "MP4"],
  videos: ["video", "videos", "MP4"],
} as const satisfies Record<ConvertGroup, readonly [string, string, string]>;

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

type StepState = "todo" | "running" | "done";

function Step({
  index,
  id,
  title,
  state,
  summary,
  detail,
  actions,
  result,
}: {
  index: number;
  id: string;
  title: string;
  state: StepState;
  summary: ReactNode;
  detail?: ReactNode;
  actions?: ReactNode;
  result?: ReactNode;
}) {
  return (
    <li
      data-step={id}
      data-state={state}
      className="grid grid-cols-[28px_128px_minmax(0,1fr)_auto] items-start gap-x-3 border-b ls-divider px-5 py-3.5"
    >
      <span
        className={`ls-mono mt-px flex size-5 items-center justify-center rounded-full text-[10px] ${
          state === "done"
            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
            : "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
        }`}
      >
        {state === "done" ? <Check className="size-3" /> : index}
      </span>
      <span className={`pt-0.5 text-xs font-medium ${state === "done" ? "text-zinc-500" : ""}`}>
        {title}
      </span>
      <div className="min-w-0 space-y-1 pt-0.5">
        <div className={`text-xs ${state === "done" ? "text-zinc-500" : ""}`}>{summary}</div>
        {detail ? <div className="ls-mono text-[10.5px] text-zinc-500">{detail}</div> : null}
        {result}
      </div>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </li>
  );
}

/** A finished plan's line under its step, with Undo while it can still be undone. */
function ResultLine({ plan }: { plan: PlanSummary }) {
  const { undoPlan } = useActions();

  return (
    <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-emerald-700 dark:text-emerald-300">
      <Check className="size-3" />
      <span>{plan.title}</span>
      {describePlan(plan) ? (
        <span className="ls-mono text-[10.5px] text-zinc-500">{describePlan(plan)}</span>
      ) : null}
      {canUndo(plan) ? (
        <button
          type="button"
          className="text-violet-700 underline-offset-2 hover:underline dark:text-violet-300"
          onClick={() => void undoPlan(plan)}
        >
          Undo
        </button>
      ) : null}
    </div>
  );
}

/** Inline progress for a step whose plan is running, with Pause and Stop. */
function RunningLine({ job }: { job: Job }) {
  const { report } = useEngine();

  return (
    <div className="flex items-center gap-3">
      <div className="w-56">
        <ProgressBar ratio={job.total > 0 ? job.done / job.total : null} />
      </div>
      <span className="ls-mono text-[10.5px] text-zinc-500 tabular">
        {job.state === "paused"
          ? "paused"
          : job.total > 0
            ? `${formatCount(job.done)} of ${formatCount(job.total)}`
            : "starting"}
      </span>
      <button
        type="button"
        className="ls-btn ls-btn-ghost px-1 py-0"
        aria-label={job.state === "paused" ? "Resume" : "Pause"}
        onClick={() =>
          void call("pauseJob", { jobId: job.id, paused: job.state !== "paused" }).catch(report)
        }
      >
        {job.state === "paused" ? <Play className="size-3" /> : <Pause className="size-3" />}
      </button>
      <button
        type="button"
        className="ls-btn ls-btn-ghost px-1 py-0"
        aria-label="Stop"
        onClick={() => void call("cancelJob", { jobId: job.id }).catch(report)}
      >
        <Square className="size-3" />
      </button>
    </div>
  );
}

function AnalysisNote({
  job,
  done,
  total,
  noun,
}: {
  job: Job | null;
  done: number;
  total: number;
  noun: string;
}) {
  if (done >= total) {
    return null;
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      {job ? <Spinner /> : null}
      {job ? `${noun} ` : `${noun} not checked yet: `}
      {formatCount(done)} of {formatCount(total)}
    </span>
  );
}

function joinParts(parts: ReadonlyArray<string | false | null>): string {
  return parts.filter(Boolean).join(" · ");
}

export function TidyView({ rootId }: { rootId: RootId }) {
  const tidy = useEngineQuery("tidy", { rootId });
  const scan = useActiveJob("scan", rootId);
  const { report } = useEngine();
  const { go } = useNavigation();

  useViewKeys((event) => {
    if (isPlainKey(event) && event.key.toLowerCase() === "d") {
      go("duplicates");

      return true;
    }

    return false;
  });

  const data = tidy.data;

  if (!data) {
    return <EmptyState title={tidy.error ?? "Reading the catalog…"} />;
  }

  if (data.files === 0) {
    return (
      <EmptyState title={scan ? "Scanning…" : "This folder is empty"}>
        {scan ? null : (
          <button
            type="button"
            className="ls-btn"
            onClick={() => void call("scanRoot", { rootId }).catch(report)}
          >
            <RefreshCw className="size-3.5" /> Rescan
          </button>
        )}
      </EmptyState>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewHeader title="Tidy" meta={`${plural(data.files, "file")} · ${formatBytes(data.bytes)}`}>
        {scan ? (
          <span className="ls-mono inline-flex items-center gap-1.5 text-[10.5px] text-zinc-500">
            <Spinner /> scanning
          </span>
        ) : (
          <button
            type="button"
            className="ls-btn ls-btn-ghost"
            onClick={() => void call("scanRoot", { rootId }).catch(report)}
          >
            <RefreshCw className="size-3.5" /> Rescan <Kbd>⌘R</Kbd>
          </button>
        )}
      </ViewHeader>
      <TidySteps rootId={rootId} data={data} />
    </div>
  );
}

function TidySteps({ rootId, data }: { rootId: RootId; data: Tidy }) {
  const { settings, capabilities, report } = useEngine();
  const actions = useActions();
  const { go, openLibrary } = useNavigation();
  const similarJob = useActiveJob("similar", rootId);
  const soundJob = useActiveJob("sound", rootId);
  const level = settings?.similarity ?? "balanced";

  const [groups, setGroups] = useState<ReadonlySet<ConvertGroup>>(
    () => new Set(CONVERT_GROUPS.map((group) => group.id)),
  );

  // Size after conversion as a share of before, per category; null when no sample converted.
  const [ratios, setRatios] = useState<ReadonlyMap<string, number | null>>(new Map());

  const categoryCount = (category: OptimizeCategory) =>
    data.convert.categories.find((entry) => entry.category === category) ?? {
      category,
      files: 0,
      bytes: 0,
    };

  // Estimates come from converting a small sample once; the engine caches them per category.
  const estimateKeys = CONVERT_GROUPS.flatMap((group) =>
    group.categories.flatMap((category) => {
      const entry = categoryCount(category);

      return entry.files > 0 ? [`${category}:${entry.files}:${entry.bytes}`] : [];
    }),
  ).join("|");

  useEffect(() => {
    let cancelled = false;

    for (const key of estimateKeys.split("|").filter(Boolean)) {
      const category = CONVERT_GROUPS.flatMap((group) => group.categories).find((candidate) =>
        key.startsWith(`${candidate}:`),
      );

      if (category === undefined) {
        continue;
      }

      call("estimateOptimize", { rootId, category }).then(
        (estimate) => {
          if (!cancelled) {
            setRatios((current) =>
              new Map(current).set(key, estimate.sampled > 0 ? estimate.ratio : null),
            );
          }
        },
        () => !cancelled && setRatios((current) => new Map(current).set(key, null)),
      );
    }

    return () => {
      cancelled = true;
    };
  }, [estimateKeys, rootId]);

  // Duplicates
  const { exact, similar } = data.duplicates;
  const duplicateSets = exact.sets + similar.sets;
  const extras = exact.extraCopies + similar.extraCopies;
  const duplicateJob = actions.jobFor("tidy:duplicates");
  const duplicateResult = actions.resultFor("tidy:duplicates");
  const fingerprinting = data.analysis.fingerprinted < data.analysis.fingerprintable;

  // Convert
  const chosen = CONVERT_GROUPS.filter((group) => groups.has(group.id));
  const chosenCategories = chosen.flatMap((group) => [...group.categories]);
  let convertFiles = 0;
  let convertBytes = 0;
  let estimatedAfter = 0;
  let estimating = false;
  let unknownEstimate = false;

  for (const category of chosenCategories) {
    const entry = categoryCount(category);

    if (entry.files === 0) {
      continue;
    }

    convertFiles += entry.files;
    convertBytes += entry.bytes;

    const ratio = ratios.get(`${category}:${entry.files}:${entry.bytes}`);

    if (ratio === undefined) {
      estimating = true;
    } else if (ratio === null) {
      unknownEstimate = true;
    } else {
      estimatedAfter += entry.bytes * ratio;
    }
  }

  const allConvertFiles = CONVERT_GROUPS.flatMap((group) => [...group.categories]).reduce(
    (sum, category) => sum + categoryCount(category).files,
    0,
  );

  const convertJob = actions.jobFor("tidy:convert");
  const convertResult = actions.resultFor("tidy:convert");
  const skipped = data.convert.skipped.reduce((sum, entry) => sum + entry.files, 0);
  const noVideoEncoder = capabilities !== null && !capabilities.video.avc && !capabilities.ffmpeg;

  // Silent tracks
  const silentJob = actions.jobFor("tidy:silent");
  const silentResult = actions.resultFor("tidy:silent");
  const measuring = data.analysis.soundMeasured < data.analysis.soundMeasurable;

  // Clean-up
  const { junk, emptyFolders, extensions } = data.cleanup;
  const cleanupCount = junk + emptyFolders + extensions;
  const cleanupJob = actions.jobFor("tidy:cleanup");
  const cleanupResult = actions.resultFor("tidy:cleanup");

  const attention = data.attention.filter((finding) => finding.count > 0);

  const tidyNow =
    duplicateSets === 0 &&
    allConvertFiles === 0 &&
    data.silentTracks.files === 0 &&
    cleanupCount === 0 &&
    !fingerprinting &&
    !measuring;

  const anyResult = [duplicateResult, convertResult, silentResult, cleanupResult].some(Boolean);

  const stripSilent = async () => {
    const { ids } = await call("listFileIds", {
      rootId,
      search: "",
      kinds: ["video"],
      formats: [],
      audioStates: ["silent"],
      flags: [],
      dir: null,
    });

    if (ids.length > 0) {
      await actions.perform({ kind: "strip-audio", fileIds: ids }, { source: "tidy:silent" });
    }
  };

  const stateOf = (job: Job | null, open: boolean): StepState =>
    job ? "running" : open ? "todo" : "done";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {tidyNow ? (
        <div className="flex items-center gap-2 border-b ls-divider bg-emerald-500/5 px-5 py-3 text-xs text-emerald-800 dark:text-emerald-200">
          <Check className="size-3.5" />
          This folder is tidy.
        </div>
      ) : null}

      <ol>
        <Step
          index={1}
          id="duplicates"
          title="Duplicates"
          state={stateOf(duplicateJob, duplicateSets > 0)}
          summary={
            duplicateSets > 0
              ? `${plural(extras, "extra copy", "extra copies")} · ${formatBytes(
                  exact.reclaimableBytes + similar.reclaimableBytes,
                )}`
              : "No duplicates"
          }
          detail={
            <>
              {joinParts([
                exact.sets > 0 &&
                  plural(exact.sets, "set of identical copies", "sets of identical copies"),
                similar.sets > 0 &&
                  plural(similar.sets, "set of similar versions", "sets of similar versions"),
              ])}
              {fingerprinting ? (
                <span className="ml-2">
                  <AnalysisNote
                    job={similarJob}
                    done={data.analysis.fingerprinted}
                    total={data.analysis.fingerprintable}
                    noun="similar versions"
                  />
                </span>
              ) : null}
            </>
          }
          result={
            duplicateJob ? (
              <RunningLine job={duplicateJob} />
            ) : duplicateResult ? (
              <ResultLine plan={duplicateResult} />
            ) : null
          }
          actions={
            <>
              {fingerprinting && similarJob === null && settings?.autoAnalyze === false ? (
                <button
                  type="button"
                  className="ls-btn"
                  onClick={() => void call("analyzeSimilar", { rootId }).catch(report)}
                >
                  Find similar versions
                </button>
              ) : null}
              {exact.extraCopies > 0 && duplicateJob === null ? (
                <button
                  type="button"
                  className="ls-btn"
                  onClick={() =>
                    void actions.perform(
                      {
                        kind: "resolve-duplicate-sets",
                        rootId,
                        level,
                        scope: "exact",
                        overrides: [],
                        skip: [],
                      },
                      { source: "tidy:duplicates", confirmLabel: "Remove anyway" },
                    )
                  }
                >
                  Remove {plural(exact.extraCopies, "identical copy", "identical copies")}
                </button>
              ) : null}
              {duplicateSets > 0 ? (
                <button
                  type="button"
                  className={`ls-btn ${similar.sets > 0 ? "ls-btn-primary" : ""}`}
                  onClick={() => go("duplicates")}
                >
                  Review <Kbd>D</Kbd>
                </button>
              ) : null}
            </>
          }
        />

        <Step
          index={2}
          id="convert"
          title="Convert"
          state={stateOf(convertJob, allConvertFiles > 0)}
          summary={
            allConvertFiles === 0 ? (
              "Everything is AVIF or MP4"
            ) : convertFiles === 0 ? (
              "Nothing chosen"
            ) : (
              <>
                {plural(convertFiles, "file")} · {formatBytes(convertBytes)}{" "}
                <span className="text-zinc-500">
                  {estimating
                    ? "→ estimating…"
                    : unknownEstimate
                      ? null
                      : `→ about ${formatBytes(estimatedAfter)}`}
                </span>
              </>
            )
          }
          detail={
            allConvertFiles > 0 ? (
              <>
                {joinParts(
                  chosen.map((group) => {
                    const files = group.categories.reduce(
                      (sum, category) => sum + categoryCount(category).files,
                      0,
                    );

                    const [singular, pluralForm, target] = GROUP_NOUNS[group.id];

                    return files > 0 && `${plural(files, singular, pluralForm)} → ${target}`;
                  }),
                )}
                {skipped > 0 ? (
                  <span
                    className="ml-2 cursor-help underline decoration-dotted underline-offset-2"
                    title={data.convert.skipped
                      .map((entry) => `${formatCount(entry.files)} ${entry.reason}`)
                      .join("\n")}
                  >
                    {formatCount(skipped)} left as they are
                  </span>
                ) : null}
                {noVideoEncoder ? (
                  <span className="ml-2 text-amber-700 dark:text-amber-300">
                    no H.264 encoder on this machine
                  </span>
                ) : null}
              </>
            ) : skipped > 0 ? (
              <span
                className="cursor-help underline decoration-dotted underline-offset-2"
                title={data.convert.skipped
                  .map((entry) => `${formatCount(entry.files)} ${entry.reason}`)
                  .join("\n")}
              >
                {formatCount(skipped)} left as they are
              </span>
            ) : null
          }
          result={
            convertJob ? (
              <RunningLine job={convertJob} />
            ) : convertResult ? (
              <ResultLine plan={convertResult} />
            ) : null
          }
          actions={
            allConvertFiles > 0 && convertJob === null ? (
              <>
                <Dropdown label="Options">
                  {() => (
                    <>
                      {CONVERT_GROUPS.map((group) => {
                        const files = group.categories.reduce(
                          (sum, category) => sum + categoryCount(category).files,
                          0,
                        );

                        return (
                          <MenuCheck
                            key={group.id}
                            label={group.label}
                            count={formatCount(files)}
                            disabled={files === 0}
                            checked={groups.has(group.id) && files > 0}
                            onChange={(checked) => {
                              const next = new Set(groups);

                              if (checked) {
                                next.add(group.id);
                              } else {
                                next.delete(group.id);
                              }

                              setGroups(next);
                            }}
                          />
                        );
                      })}
                      <p className="px-2 pt-1 pb-0.5 text-[10.5px] text-zinc-500">
                        Pictures use AVIF at quality 70. Video tracks MP4 can hold are copied as
                        they are.
                      </p>
                      <button
                        type="button"
                        className="mt-1 w-full rounded px-2 py-1 text-left text-xs text-violet-700 hover:bg-zinc-100 dark:text-violet-300 dark:hover:bg-zinc-800"
                        onClick={() => openLibrary({ flags: ["convertible"] })}
                      >
                        Show these files in the Library
                      </button>
                    </>
                  )}
                </Dropdown>
                <button
                  type="button"
                  className="ls-btn ls-btn-cta"
                  disabled={convertFiles === 0}
                  onClick={() =>
                    void actions.perform(
                      { kind: "optimize", rootId, categories: chosenCategories, fileIds: null },
                      { source: "tidy:convert" },
                    )
                  }
                >
                  Convert {formatCount(convertFiles)}
                </button>
              </>
            ) : null
          }
        />

        <Step
          index={3}
          id="silent"
          title="Silent tracks"
          state={stateOf(silentJob, data.silentTracks.files > 0)}
          summary={
            data.silentTracks.files > 0
              ? `${plural(data.silentTracks.files, "video")} with a silent soundtrack`
              : measuring
                ? "No silent soundtracks found yet"
                : "No silent soundtracks"
          }
          detail={
            measuring ? (
              <AnalysisNote
                job={soundJob}
                done={data.analysis.soundMeasured}
                total={data.analysis.soundMeasurable}
                noun="soundtracks"
              />
            ) : null
          }
          result={
            silentJob ? (
              <RunningLine job={silentJob} />
            ) : silentResult ? (
              <ResultLine plan={silentResult} />
            ) : null
          }
          actions={
            <>
              {measuring && soundJob === null && settings?.autoAnalyze === false ? (
                <button
                  type="button"
                  className="ls-btn"
                  onClick={() => void call("analyzeSound", { rootId }).catch(report)}
                >
                  Measure
                </button>
              ) : null}
              {data.silentTracks.files > 0 && silentJob === null ? (
                <>
                  <button
                    type="button"
                    className="ls-btn ls-btn-ghost"
                    onClick={() => openLibrary({ kinds: ["video"], audioStates: ["silent"] })}
                  >
                    Show
                  </button>
                  <button type="button" className="ls-btn" onClick={() => void stripSilent()}>
                    Remove silent tracks
                  </button>
                </>
              ) : null}
            </>
          }
        />

        <Step
          index={4}
          id="cleanup"
          title="Clean up"
          state={stateOf(cleanupJob, cleanupCount > 0)}
          summary={
            cleanupCount > 0
              ? joinParts([
                  junk > 0 && plural(junk, "junk file"),
                  emptyFolders > 0 && plural(emptyFolders, "empty folder"),
                  extensions > 0 && plural(extensions, "wrong extension"),
                ])
              : "Nothing to clean up"
          }
          result={
            cleanupJob ? (
              <RunningLine job={cleanupJob} />
            ) : cleanupResult ? (
              <ResultLine plan={cleanupResult} />
            ) : null
          }
          actions={
            cleanupCount > 0 && cleanupJob === null ? (
              <button
                type="button"
                className="ls-btn"
                onClick={() =>
                  void actions.perform({ kind: "cleanup", rootId }, { source: "tidy:cleanup" })
                }
              >
                Clean up
              </button>
            ) : null
          }
        />
      </ol>

      {attention.length > 0 ? (
        <div
          className="grid grid-cols-[28px_128px_minmax(0,1fr)] gap-x-3 px-5 py-3.5 text-xs"
          data-step="attention"
        >
          <span />
          <span className="text-zinc-500">Needs a look</span>
          <span className="flex flex-wrap gap-x-3 gap-y-1">
            {attention.map((finding) => (
              <button
                key={finding.kind}
                type="button"
                data-finding={finding.kind}
                className="text-zinc-600 underline decoration-zinc-300 underline-offset-2 hover:text-zinc-900 dark:text-zinc-300 dark:decoration-zinc-700 dark:hover:text-zinc-100"
                onClick={() => openLibrary(ATTENTION[finding.kind].preset)}
              >
                {ATTENTION[finding.kind].label(finding.count)}
              </button>
            ))}
          </span>
        </div>
      ) : null}

      {anyResult ? (
        <p className="px-5 py-3 text-[11px] text-zinc-500">
          To bring Pane View in line, run <code className="ls-mono">lockstep plan</code>, then{" "}
          <code className="ls-mono">push</code> and <code className="ls-mono">prune</code>.
        </p>
      ) : null}
    </div>
  );
}
