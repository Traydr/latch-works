import { formatBytes } from "@latch-works/media-domain";

import type {
  PlanController,
  RunController,
  RunKind,
  RunPhase,
} from "../hooks/useLockstepController";
import { formatClock } from "../lib/run-formatters";
import { describeRemoteEntries } from "../lib/run-lifecycle";
import { currentRate, estimateRemainingMs, throughputSeries } from "../lib/run-metrics";
import { ProgressBar, type ProgressTone, useNow } from "./syncPrimitives";

const CHART_BUCKETS = 48;

const CHART_WIDTH = 240;

const CHART_HEIGHT = 46;

interface RunPanelProps {
  run: RunController;
  plan: PlanController;
  /** Closes the panel once the run has ended. */
  onDone: () => void;
}

/** The right-hand panel: shown while a run goes, and after a push or prune until dismissed. */
export function RunPanel({ run, plan, onDone }: RunPanelProps) {
  const { running, runProgress: progress } = run;
  const now = useNow(running, 500);
  const endedAt = progress.endedAt ?? now;
  const elapsed = progress.startedAt ? endedAt - progress.startedAt : 0;
  const itemRun = progress.kind === "push" || progress.kind === "prune";

  return (
    <aside
      aria-label="Run"
      className="flex w-[268px] shrink-0 flex-col border-l border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60"
    >
      {itemRun && progress.queuedAt != null ? (
        <ItemRunBody run={run} now={endedAt} elapsed={elapsed} />
      ) : (
        <PreparingBody run={run} elapsed={elapsed} />
      )}
      <div className="mt-auto flex flex-col gap-2 p-3">
        {running ? (
          <>
            <button
              type="button"
              className="ls-btn ls-btn-danger h-7"
              onClick={() => void run.handleCancel()}
            >
              Cancel {progress.kind || "run"}
            </button>
            {progress.kind === "push" ? (
              <p className="text-[10.5px] leading-snug text-zinc-500">
                Items already uploading finish first. Pushing again picks up what is left.
              </p>
            ) : null}
          </>
        ) : (
          <FinishedActions run={run} plan={plan} onDone={onDone} />
        )}
      </div>
    </aside>
  );
}

function FinishedActions({ run, plan, onDone }: RunPanelProps) {
  const { runProgress: progress } = run;
  const prune = plan.pruneAvailability;

  return (
    <>
      <button type="button" className="ls-btn ls-btn-cta h-7" onClick={onDone}>
        Done
      </button>
      {progress.kind === "push" && prune.enabled ? (
        <button
          type="button"
          data-action="prune"
          className="ls-btn ls-btn-danger h-7"
          onClick={() => void run.handlePrune()}
          title={`Delete the ${describeRemoteEntries(prune.deleteCount)} the reviewed plan lists`}
        >
          Prune {prune.deleteCount.toLocaleString()}…
        </button>
      ) : null}
      {progress.kind === "push" && progress.failed > 0 ? (
        <button type="button" className="ls-btn h-7" onClick={() => void run.handlePush()}>
          Retry {progress.failed.toLocaleString()} failed
        </button>
      ) : null}
    </>
  );
}

/** Planning, doctor, or the scan a push does before its first upload. */
function PreparingBody({ run, elapsed }: { run: RunController; elapsed: number }) {
  const { running, runLabel, runProgress: progress } = run;

  const title =
    progress.kind === "doctor"
      ? "Running doctor"
      : progress.kind === "plan"
        ? "Planning"
        : `Preparing ${progress.kind || "run"}`;

  return (
    <div className="flex flex-col gap-3 border-b border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex items-baseline">
        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {running ? title : runLabel}
        </span>
        <span className="ml-auto ls-mono text-[10.5px] text-zinc-500 tabular-nums">
          {formatClock(elapsed)}
        </span>
      </div>
      <ProgressBar percent={running ? null : 1} indeterminate={running} />
      <p className="truncate ls-mono text-[10.5px] text-zinc-500" title={runLabel}>
        {runLabel}
      </p>
      {progress.scanFilesFound > 0 ? (
        <div className="grid grid-cols-2 gap-2.5">
          <Stat label="files" value={progress.scanFilesFound.toLocaleString()} />
          <Stat label="hashed" value={formatBytes(progress.bytesHashed)} />
        </div>
      ) : null}
    </div>
  );
}

function ItemRunBody({ run, now, elapsed }: { run: RunController; now: number; elapsed: number }) {
  const { running, runProgress: progress } = run;
  const byBytes = progress.bytesTotal > 0;
  const processed = progress.pushed + progress.failed + progress.skipped;
  const bytesProcessed = progress.bytesDone + progress.bytesFailed;

  const percent =
    progress.phase === "done"
      ? 1
      : byBytes
        ? bytesProcessed / progress.bytesTotal
        : progress.itemTotal > 0
          ? processed / progress.itemTotal
          : 0;

  const queuedFor = now - (progress.queuedAt ?? now);

  const rate = running
    ? currentRate({ now, since: progress.queuedAt ?? now, spans: progress.spans })
    : queuedFor > 0
      ? progress.bytesDone / (queuedFor / 1000)
      : 0;

  const remainingMs = byBytes
    ? estimateRemainingMs(progress.bytesTotal - bytesProcessed, rate)
    : processed > 0
      ? ((progress.itemTotal - processed) * queuedFor) / processed
      : null;

  const tone: ProgressTone =
    progress.phase === "error" || progress.phase === "cancelled" || progress.failed > 0
      ? running
        ? "violet"
        : "red"
      : progress.phase === "done"
        ? "emerald"
        : "violet";

  const verb = progress.kind === "prune" ? "deleted" : "pushed";

  return (
    <>
      <div className="border-b border-zinc-200 p-3 dark:border-zinc-800">
        {running ? (
          <div className="flex items-baseline">
            <span className="text-[26px] leading-none font-semibold tracking-tight text-zinc-900 tabular-nums dark:text-zinc-100">
              {Math.floor(percent * 100)}%
            </span>
            <span className="ml-auto ls-mono text-[11px] text-zinc-500 tabular-nums">
              {remainingMs == null ? "ETA —" : `ETA ${formatClock(remainingMs)}`}
            </span>
          </div>
        ) : (
          <div className="flex items-baseline">
            <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {finishedTitle(progress.kind, progress.phase, progress.failed)}
            </span>
            <span className="ml-auto ls-mono text-[10.5px] text-zinc-500 tabular-nums">
              {formatClock(elapsed)}
            </span>
          </div>
        )}
        <ProgressBar percent={percent} tone={tone} className="mt-2.5 h-2" />
        <div className="mt-1.5 flex ls-mono text-[10.5px] text-zinc-500 tabular-nums">
          <span>
            {byBytes
              ? `${formatBytes(bytesProcessed)} / ${formatBytes(progress.bytesTotal)}`
              : `${processed.toLocaleString()} / ${progress.itemTotal.toLocaleString()} items`}
          </span>
          {running ? <span className="ml-auto">elapsed {formatClock(elapsed)}</span> : null}
        </div>
      </div>
      {byBytes ? (
        <div className="border-b border-zinc-200 p-3 dark:border-zinc-800">
          <div className="flex items-baseline">
            <span className="ls-label">Throughput</span>
            <span className="ml-auto ls-mono text-xs text-zinc-800 tabular-nums dark:text-zinc-100">
              {formatBytes(rate)}/s{running ? "" : " avg"}
            </span>
          </div>
          <ThroughputChart run={run} now={now} />
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2.5 border-b border-zinc-200 p-3 dark:border-zinc-800">
        <Stat
          label={verb}
          value={`${progress.pushed.toLocaleString()} / ${progress.itemTotal.toLocaleString()}`}
          tone="text-emerald-600 dark:text-emerald-300"
        />
        <Stat
          label="failed"
          value={progress.failed.toLocaleString()}
          tone={progress.failed > 0 ? "text-red-600 dark:text-red-300" : undefined}
        />
        {progress.skipped > 0 ? (
          <Stat label="skipped" value={progress.skipped.toLocaleString()} />
        ) : null}
      </div>
    </>
  );
}

function finishedTitle(kind: RunKind, phase: RunPhase, failed: number): string {
  const name = kind === "prune" ? "Prune" : "Push";

  if (phase === "cancelled") {
    return `${name} cancelled`;
  }

  if (phase === "error") {
    return `${name} failed`;
  }

  return failed > 0 ? `${name} finished with failures` : `${name} complete`;
}

function ThroughputChart({ run, now }: { run: RunController; now: number }) {
  const { runProgress: progress } = run;
  const startedAt = progress.queuedAt ?? now;
  const span = Math.max(now - startedAt, 1000);

  const series = throughputSeries({
    bucketCount: CHART_BUCKETS,
    endedAt: now,
    spans: progress.spans,
    startedAt,
  });

  const peak = Math.max(...series, 1);
  const step = CHART_WIDTH / (CHART_BUCKETS - 1);

  const points = series.map((rate, index) => {
    const y = CHART_HEIGHT - 3 - (rate / peak) * (CHART_HEIGHT - 8);

    return `${(index * step).toFixed(1)},${y.toFixed(1)}`;
  });

  const line = `M${points.join(" L")}`;
  const area = `${line} L${CHART_WIDTH},${CHART_HEIGHT} L0,${CHART_HEIGHT} Z`;

  return (
    <svg
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      preserveAspectRatio="none"
      className="mt-2 block h-[46px] w-full"
      role="img"
      aria-label="Upload throughput over the run"
    >
      <defs>
        <linearGradient id="ls-throughput-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8b5cf6" stopOpacity="0.35" />
          <stop offset="1" stopColor="#8b5cf6" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#ls-throughput-fill)" />
      <path
        d={line}
        fill="none"
        stroke="#a78bfa"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
      {progress.failureTimes.map((at, index) => {
        const x = ((at - startedAt) / span) * CHART_WIDTH;

        return (
          <line
            // biome-ignore lint/suspicious/noArrayIndexKey: failures can share a timestamp.
            key={`${at}:${index}`}
            x1={x}
            x2={x}
            y1={0}
            y2={CHART_HEIGHT}
            stroke="#ef4444"
            strokeDasharray="2 2"
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </svg>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <p className="ls-label">{label}</p>
      <p
        data-stat={label}
        className={`mt-0.5 truncate ls-mono text-base tabular-nums ${tone ?? "text-zinc-800 dark:text-zinc-200"}`}
      >
        {value}
      </p>
    </div>
  );
}
