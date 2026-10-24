import { type JSX, useState } from "react";

import { SettingsGroup, SettingsRow } from "../../../../shell/Settings";
import { Switch } from "../../../../ui/ui";
import type {
  AppSettings,
  AppSettingsPatch,
  DiagnosticsSnapshot,
  MediaIndexStats,
} from "../../shared/types";

export interface CurrentFolderSummary {
  folderName: string | null;
  itemCount: number;
  recursive: boolean;
  scanState: "idle" | "loading" | "done" | "error";
}

interface ViewDiagnosticsProps {
  currentFolderSummary: CurrentFolderSummary;
  diagnosticsSnapshot: DiagnosticsSnapshot | null;
  mediaIndexStats: MediaIndexStats | null;
  onCopyDiagnostics: () => Promise<void> | void;
  onRefreshDiagnostics: () => Promise<void> | void;
  onUpdate: (patch: AppSettingsPatch) => void;
  settings: AppSettings;
}

type Fact = readonly [label: string, value: string | number];

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function timing(span: { averageMs: number; maxMs: number } | null | undefined): string {
  return `${span?.averageMs ?? 0} ms average, ${span?.maxMs ?? 0} ms at most`;
}

/** One titled list of facts, the label left and the value right. */
function Facts({ title, facts }: { title: string; facts: readonly Fact[] }) {
  return (
    <div className="border-t lw-divider px-4 py-3">
      <h3 className="mb-1.5 text-[13px] font-medium">{title}</h3>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-0.5 text-xs tabular-nums">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-zinc-500 dark:text-zinc-400">{label}</dt>
            <dd className="min-w-0 text-right break-all">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** A list of recorded lines, such as recent worker events; "None" when it is empty. */
function Lines({ title, lines }: { title: string; lines: readonly string[] }) {
  return (
    <div className="border-t lw-divider px-4 py-3">
      <h3 className="mb-1.5 text-[13px] font-medium">{title}</h3>
      {lines.length > 0 ? (
        <ul className="space-y-0.5 text-xs break-all text-zinc-600 dark:text-zinc-300">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : (
        <p className="lw-caption">None</p>
      )}
    </div>
  );
}

function Details({
  currentFolderSummary: folder,
  diagnosticsSnapshot: snapshot,
  mediaIndexStats,
}: Pick<ViewDiagnosticsProps, "currentFolderSummary" | "diagnosticsSnapshot" | "mediaIndexStats">) {
  if (!snapshot) {
    return <p className="lw-caption border-t lw-divider px-4 py-3">Reading diagnostics…</p>;
  }

  const { thumbnails, thumbnailWorker: worker, thumbnailWorkerPerformance: performance } = snapshot;

  return (
    <>
      <Facts
        title="Current folder"
        facts={[
          ["Folder", folder.folderName ?? "none"],
          ["Items shown", folder.itemCount],
          ["Recursive", yesNo(folder.recursive)],
          ["Scan", folder.scanState],
        ]}
      />
      <Facts
        title="Runtime"
        facts={[
          ["Version", snapshot.appVersion],
          ["Electron", snapshot.electronVersion],
          ["Platform", `${snapshot.platform} / ${snapshot.arch}`],
          ["Packaged", yesNo(snapshot.isPackaged)],
        ]}
      />
      <Facts
        title="Thumbnails"
        facts={[
          ["Image workers", thumbnails.imageWorkerCount],
          ["Video workers", thumbnails.videoWorkerCount],
          ["Images queued", thumbnails.imageQueueDepth],
          ["Videos queued", thumbnails.videoQueueDepth],
          ["In flight", thumbnails.inflightRequests],
          ["Memory cache hits", thumbnails.memoryCacheHits],
          ["Disk cache hits", thumbnails.diskCacheHits],
          ["Made", thumbnails.generatedCount],
          ["Cancelled", thumbnails.abortedCount],
          ["Video frames that failed", thumbnails.videoExtractionFailureCount],
          ["Images sharp could not read", thumbnails.sharpDecodeFailureCount],
          ["Worker crashes", thumbnails.workerCrashCount],
          ["Worker restarts", thumbnails.workerRestartCount],
        ]}
      />
      {worker ? (
        <Facts
          title="Thumbnail worker"
          facts={[
            ["Worker", worker.workerPath ?? "unknown"],
            ["sharp", worker.sharpAvailable ? "available" : "not available"],
            ["ffmpeg", worker.ffmpegAvailable ? "available" : "not available"],
            ["ffmpeg on disk", yesNo(worker.ffmpegExists)],
            ["ffmpeg path", worker.ffmpegPath ?? "unknown"],
            ["ffprobe", worker.ffprobeAvailable ? "available" : "not available"],
            ["ffprobe on disk", yesNo(worker.ffprobeExists)],
            ["ffprobe path", worker.ffprobePath ?? "unknown"],
          ]}
        />
      ) : null}
      {performance ? (
        <Facts
          title="Timings"
          facts={[
            ["Memory hit", timing(performance.memoryHit)],
            ["Disk hit", timing(performance.diskHit)],
            ["Worker", timing(performance.workerGeneration)],
            ["End to end", timing(performance.endToEnd)],
          ]}
        />
      ) : null}
      {mediaIndexStats ? (
        <Facts
          title="Media index"
          facts={[
            ["Items", mediaIndexStats.totalItems],
            ["Folders", mediaIndexStats.uniqueRoots],
            ["Database", mediaIndexStats.dbPath],
          ]}
        />
      ) : null}
      <Lines title="Worker probe errors" lines={worker?.probeErrors ?? []} />
      <Lines title="Recent worker events" lines={thumbnails.recentWorkerEvents} />
      <Lines title="Recent thumbnail failures" lines={thumbnails.recentFailures} />
    </>
  );
}

/**
 * View's diagnostics, for reporting a problem with a packaged build or its thumbnails: two
 * switches that persist across launches, the export, and Frame View's numbers behind Show.
 */
export function ViewDiagnostics({
  onCopyDiagnostics,
  onRefreshDiagnostics,
  onUpdate,
  settings,
  ...details
}: ViewDiagnosticsProps): JSX.Element {
  const [status, setStatus] = useState<string | null>(null);
  const [shown, setShown] = useState(false);

  const run = (action: () => Promise<void> | void, done: string, failed: string) => () => {
    void (async () => {
      try {
        await action();
        setStatus(done);
      } catch {
        setStatus(failed);
      }
    })();
  };

  return (
    <SettingsGroup title="Diagnostics">
      <SettingsRow label="Enable debug logging">
        <Switch
          label="Enable debug logging"
          checked={settings.debug.enableDebugLogging}
          onChange={(enableDebugLogging) =>
            onUpdate({ debug: { ...settings.debug, enableDebugLogging } })
          }
        />
      </SettingsRow>
      <SettingsRow
        label="Enable performance monitoring"
        description="Kept across launches, so a packaged build can be profiled without a rebuild."
      >
        <Switch
          label="Enable performance monitoring"
          checked={settings.debug.enablePerformanceMonitoring}
          onChange={(enablePerformanceMonitoring) =>
            onUpdate({ debug: { ...settings.debug, enablePerformanceMonitoring } })
          }
        />
      </SettingsRow>
      <SettingsRow
        label="Diagnostics"
        description={status ?? "Worker, cache and runtime details, to paste into a bug report."}
      >
        <button
          type="button"
          className="lw-btn lw-btn-secondary"
          aria-expanded={shown}
          onClick={() => setShown((current) => !current)}
        >
          {shown ? "Hide" : "Show"}
        </button>
        <button
          type="button"
          className="lw-btn lw-btn-secondary"
          onClick={run(onRefreshDiagnostics, "Diagnostics refreshed", "Could not refresh")}
        >
          Refresh
        </button>
        <button
          type="button"
          className="lw-btn lw-btn-secondary"
          onClick={run(onCopyDiagnostics, "Copied to the clipboard", "Could not copy")}
        >
          Copy diagnostics
        </button>
      </SettingsRow>
      {shown ? <Details {...details} /> : null}
    </SettingsGroup>
  );
}
