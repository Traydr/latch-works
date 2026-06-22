import type { JSX } from 'react';

import type {
  AppSettings,
  AppSettingsPatch,
  DiagnosticsSnapshot,
  MediaIndexStats,
} from '../../../shared/types';
import { SettingsSection } from './SettingsSection';
import { SettingsToggleRow } from './SettingsToggleRow';

interface CurrentFolderSummary {
  folderName: string | null;
  itemCount: number;
  recursive: boolean;
  scanState: 'idle' | 'loading' | 'done' | 'error';
}

function DiagnosticsList({ title, values }: { title: string; values: string[] }): JSX.Element {
  return (
    <SettingsSection className="space-y-2">
      <p className="text-zinc-500 dark:text-zinc-400">{title}</p>
      {values.length > 0 ? (
        <div className="space-y-1 rounded-xl border border-zinc-200/70 bg-white/60 p-3 text-xs text-zinc-600 dark:border-zinc-700/70 dark:bg-zinc-900/40 dark:text-zinc-300">
          {values.map((value) => (
            <p key={value} className="break-all">
              {value}
            </p>
          ))}
        </div>
      ) : (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">None recorded</p>
      )}
    </SettingsSection>
  );
}

interface DebugTabProps {
  copyStatus: string | null;
  currentFolderSummary: CurrentFolderSummary;
  diagnosticsSnapshot: DiagnosticsSnapshot | null;
  mediaIndexStats: MediaIndexStats | null;
  onCopyDiagnostics: () => void;
  onRefreshDiagnostics: () => void;
  onUpdate: (patch: AppSettingsPatch) => void;
  settings: AppSettings;
}

export function DebugTab({
  copyStatus,
  currentFolderSummary,
  diagnosticsSnapshot,
  mediaIndexStats,
  onCopyDiagnostics,
  onRefreshDiagnostics,
  onUpdate,
  settings,
}: DebugTabProps): JSX.Element {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <SettingsSection className="space-y-2">
          <p className="text-zinc-500 dark:text-zinc-400">Runtime toggles</p>
          <SettingsToggleRow
            checked={settings.debug.enableDebugLogging}
            label="Enable debug logging"
            onChange={(checked) =>
              onUpdate({
                debug: {
                  ...settings.debug,
                  enableDebugLogging: checked,
                },
              })
            }
          />
          <SettingsToggleRow
            checked={settings.debug.enablePerformanceMonitoring}
            label="Enable performance monitoring"
            onChange={(checked) =>
              onUpdate({
                debug: {
                  ...settings.debug,
                  enablePerformanceMonitoring: checked,
                },
              })
            }
          />
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            These toggles persist across launches so packaged builds can be profiled without
            rebuilding.
          </p>
        </SettingsSection>

        <SettingsSection className="space-y-2">
          <p className="text-zinc-500 dark:text-zinc-400">Diagnostics export</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="prism-btn" onClick={onRefreshDiagnostics}>
              Refresh
            </button>
            <button type="button" className="prism-btn" onClick={onCopyDiagnostics}>
              Copy Diagnostics
            </button>
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {copyStatus ??
              'Use this when reporting packaged-build issues or thumbnail worker problems.'}
          </p>
        </SettingsSection>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <SettingsSection className="space-y-2">
          <p className="text-zinc-500 dark:text-zinc-400">Current view</p>
          <div className="space-y-1 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
            <p>Folder: {currentFolderSummary.folderName ?? 'none'}</p>
            <p>Visible items: {currentFolderSummary.itemCount}</p>
            <p>Recursive: {currentFolderSummary.recursive ? 'enabled' : 'disabled'}</p>
            <p>Scan state: {currentFolderSummary.scanState}</p>
          </div>
        </SettingsSection>

        <SettingsSection className="space-y-2">
          <p className="text-zinc-500 dark:text-zinc-400">Runtime environment</p>
          {diagnosticsSnapshot ? (
            <div className="space-y-1 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
              <p>Version: {diagnosticsSnapshot.appVersion}</p>
              <p>Electron: {diagnosticsSnapshot.electronVersion}</p>
              <p>
                Platform: {diagnosticsSnapshot.platform} / {diagnosticsSnapshot.arch}
              </p>
              <p>Packaged: {diagnosticsSnapshot.isPackaged ? 'yes' : 'no'}</p>
            </div>
          ) : (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Loading diagnostics...</p>
          )}
        </SettingsSection>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <SettingsSection className="space-y-2">
          <p className="text-zinc-500 dark:text-zinc-400">Thumbnail worker</p>
          {diagnosticsSnapshot?.thumbnailWorker ? (
            <div className="space-y-1 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
              <p>Worker path: {diagnosticsSnapshot.thumbnailWorker.workerPath ?? 'unknown'}</p>
              <p>
                sharp:{' '}
                {diagnosticsSnapshot.thumbnailWorker.sharpAvailable ? 'available' : 'not available'}
              </p>
              <p>
                ffmpeg:{' '}
                {diagnosticsSnapshot.thumbnailWorker.ffmpegAvailable
                  ? 'available'
                  : 'not available'}
              </p>
              <p>
                ffmpeg exists: {diagnosticsSnapshot.thumbnailWorker.ffmpegExists ? 'yes' : 'no'}
              </p>
              <p className="break-all">
                ffmpeg path: {diagnosticsSnapshot.thumbnailWorker.ffmpegPath ?? 'unknown'}
              </p>
              <p>
                ffprobe:{' '}
                {diagnosticsSnapshot.thumbnailWorker.ffprobeAvailable
                  ? 'available'
                  : 'not available'}
              </p>
              <p>
                ffprobe exists: {diagnosticsSnapshot.thumbnailWorker.ffprobeExists ? 'yes' : 'no'}
              </p>
              <p className="break-all">
                ffprobe path: {diagnosticsSnapshot.thumbnailWorker.ffprobePath ?? 'unknown'}
              </p>
            </div>
          ) : (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Worker capabilities not available yet.
            </p>
          )}
        </SettingsSection>

        <SettingsSection className="space-y-2">
          <p className="text-zinc-500 dark:text-zinc-400">Thumbnail pipeline</p>
          {diagnosticsSnapshot ? (
            <div className="space-y-1 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
              <p>Image workers: {diagnosticsSnapshot.thumbnails.imageWorkerCount}</p>
              <p>Video workers: {diagnosticsSnapshot.thumbnails.videoWorkerCount}</p>
              <p>Image queue depth: {diagnosticsSnapshot.thumbnails.imageQueueDepth}</p>
              <p>Video queue depth: {diagnosticsSnapshot.thumbnails.videoQueueDepth}</p>
              <p>Inflight requests: {diagnosticsSnapshot.thumbnails.inflightRequests}</p>
              <p>Memory cache hits: {diagnosticsSnapshot.thumbnails.memoryCacheHits}</p>
              <p>Disk cache hits: {diagnosticsSnapshot.thumbnails.diskCacheHits}</p>
              <p>Generated thumbnails: {diagnosticsSnapshot.thumbnails.generatedCount}</p>
              <p>Aborted requests: {diagnosticsSnapshot.thumbnails.abortedCount}</p>
              <p>
                Video extraction failures:{' '}
                {diagnosticsSnapshot.thumbnails.videoExtractionFailureCount}
              </p>
              <p>Sharp decode failures: {diagnosticsSnapshot.thumbnails.sharpDecodeFailureCount}</p>
              <p>Worker crashes: {diagnosticsSnapshot.thumbnails.workerCrashCount}</p>
              <p>Worker restarts: {diagnosticsSnapshot.thumbnails.workerRestartCount}</p>
            </div>
          ) : (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Loading diagnostics...</p>
          )}
        </SettingsSection>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <SettingsSection className="space-y-2">
          <p className="text-zinc-500 dark:text-zinc-400">Performance timings</p>
          {diagnosticsSnapshot?.thumbnailWorkerPerformance ? (
            <div className="space-y-1 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
              <p>
                Memory hit avg/max:{' '}
                {diagnosticsSnapshot.thumbnailWorkerPerformance.memoryHit?.averageMs ?? 0}ms /{' '}
                {diagnosticsSnapshot.thumbnailWorkerPerformance.memoryHit?.maxMs ?? 0}ms
              </p>
              <p>
                Disk hit avg/max:{' '}
                {diagnosticsSnapshot.thumbnailWorkerPerformance.diskHit?.averageMs ?? 0}ms /{' '}
                {diagnosticsSnapshot.thumbnailWorkerPerformance.diskHit?.maxMs ?? 0}ms
              </p>
              <p>
                Worker generation avg/max:{' '}
                {diagnosticsSnapshot.thumbnailWorkerPerformance.workerGeneration?.averageMs ?? 0}ms
                / {diagnosticsSnapshot.thumbnailWorkerPerformance.workerGeneration?.maxMs ?? 0}ms
              </p>
              <p>
                End-to-end avg/max:{' '}
                {diagnosticsSnapshot.thumbnailWorkerPerformance.endToEnd?.averageMs ?? 0}ms /{' '}
                {diagnosticsSnapshot.thumbnailWorkerPerformance.endToEnd?.maxMs ?? 0}ms
              </p>
            </div>
          ) : (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Performance monitoring is currently disabled.
            </p>
          )}
        </SettingsSection>

        <SettingsSection className="space-y-2">
          <p className="text-zinc-500 dark:text-zinc-400">Storage footprint</p>
          {mediaIndexStats ? (
            <div className="space-y-1 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
              <p>Indexed items: {mediaIndexStats.totalItems}</p>
              <p>Indexed roots: {mediaIndexStats.uniqueRoots}</p>
              <p>DB path: {mediaIndexStats.dbPath}</p>
              <p>
                Memory cache hits this session:{' '}
                {diagnosticsSnapshot?.thumbnails.memoryCacheHits ?? 0}
              </p>
            </div>
          ) : (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Loading storage diagnostics...
            </p>
          )}
        </SettingsSection>
      </div>

      <DiagnosticsList
        title="Worker Probe Errors"
        values={diagnosticsSnapshot?.thumbnailWorker?.probeErrors ?? []}
      />
      <DiagnosticsList
        title="Recent Worker Events"
        values={diagnosticsSnapshot?.thumbnails.recentWorkerEvents ?? []}
      />
      <DiagnosticsList
        title="Recent Thumbnail Failures"
        values={diagnosticsSnapshot?.thumbnails.recentFailures ?? []}
      />
    </div>
  );
}
