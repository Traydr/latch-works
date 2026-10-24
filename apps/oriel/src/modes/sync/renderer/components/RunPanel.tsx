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

/**
 * The run, floating over the plan's lower right: shown while a run goes, and after a push or
 * prune until dismissed.
 */
export function RunPanel({ run, plan, onDone }: RunPanelProps) {
  const { running, runProgress: progress } = run;
  const now = useNow(running, 500);
  const endedAt = progress.endedAt ?? now;
  const elapsed = progress.startedAt ? endedAt - progress.startedAt : 0;
  const itemRun = progress.kind === "push" || progress.kind === "prune";

  return (
    <aside
      aria-label="Run"
      className="lw-float lw-enter-rise absolute right-4 bottom-4 z-30 flex w-[300px] flex-col overflow-hidden"
    >
      {itemRun && progress.queuedAt != null ? (
        <ItemRunBody run={run} now={endedAt} elapsed={elapsed} />
      ) : (
        <PreparingBody run={run} elapsed={elapsed} />
      )}
      <div className="flex flex-col gap-2 p-4">
        {running ? (
          <>
            <button
              type="button"
              className="lw-btn lw-btn-secondary"
              onClick={() => void run.handleCancel()}
            >
              Cancel {progress.kind || "run"}
            </button>
            {progress.kind === "push" ? (
              <p className="lw-caption">
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
      <button type="button" className="lw-btn lw-btn-primary" onClick={onDone}>
        Done
      </button>
      {progress.kind === "push" && prune.enabled ? (
        <button
          type="button"
          data-action="prune"
          className="lw-btn lw-btn-danger"
          onClick={() => void run.handlePrune()}
          title={`Delete the ${describeRemoteEntries(prune.deleteCount)} the reviewed plan lists`}
        >
          Prune {prune.deleteCount.toLocaleString()}…
        </button>
      ) : null}
      {progress.kind === "push" && progress.failed > 0 ? (
        <button
          type="button"
          className="lw-btn lw-btn-secondary"
          onClick={() => void run.handlePush()}
        >
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
    <div className="flex flex-col gap-3 border-b lw-divider p-4">
      <div className="flex items-baseline gap-2">
        <span className="lw-heading min-w-0 truncate">{running ? title : runLabel}</span>
        <span className="lw-caption ml-auto tabular-nums">{formatClock(elapsed)}</span>
      </div>
      <ProgressBar percent={running ? null : 1} />
      <p className="lw-caption truncate" title={runLabel}>
        {runLabel}
      </p>
      {progress.scanFilesFound > 0 ? (
        <div className="grid grid-cols-2 gap-3">
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
      <div className="border-b lw-divider p-4">
        {running ? (
          <div className="flex items-baseline">
            <span className="lw-display tabular-nums">{Math.floor(percent * 100)}%</span>
            <span className="lw-caption ml-auto tabular-nums">
              {remainingMs == null ? "Estimating…" : `${formatClock(remainingMs)} left`}
            </span>
          </div>
        ) : (
          <div className="flex items-baseline gap-2">
            <span className="lw-heading min-w-0 truncate">
              {finishedTitle(progress.kind, progress.phase, progress.failed)}
            </span>
            <span className="lw-caption ml-auto tabular-nums">{formatClock(elapsed)}</span>
          </div>
        )}
        <ProgressBar percent={percent} tone={tone} className="mt-3 h-1.5" />
        <div className="lw-caption mt-2 flex tabular-nums">
          <span>
            {byBytes
              ? `${formatBytes(bytesProcessed)} / ${formatBytes(progress.bytesTotal)}`
              : `${processed.toLocaleString()} / ${progress.itemTotal.toLocaleString()} items`}
          </span>
          {running ? <span className="ml-auto">{formatClock(elapsed)} so far</span> : null}
        </div>
      </div>
      {byBytes ? (
        <div className="border-b lw-divider p-4">
          <div className="flex items-baseline">
            <span className="lw-caption">Throughput</span>
            <span className="ml-auto text-[13px] font-medium tabular-nums">
              {formatBytes(rate)}/s{running ? "" : " on average"}
            </span>
          </div>
          <ThroughputChart run={run} now={now} />
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-3 border-b lw-divider p-4">
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
        <linearGradient id="sync-throughput-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8b5cf6" stopOpacity="0.35" />
          <stop offset="1" stopColor="#8b5cf6" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#sync-throughput-fill)" />
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
      <p className="lw-caption first-letter:uppercase">{label}</p>
      <p
        data-stat={label}
        className={`mt-0.5 truncate text-[15px] font-semibold tabular-nums ${tone ?? "text-zinc-900 dark:text-zinc-100"}`}
      >
        {value}
      </p>
    </div>
  );
}
