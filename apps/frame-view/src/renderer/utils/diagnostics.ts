import type { ThumbnailTimingAggregate } from '../../shared/thumbnail';
import type { DiagnosticsSnapshot } from '../../shared/types';

interface RendererDiagnosticsContext {
  folderName: string | null;
  itemCount: number;
  recursive: boolean;
  scanState: 'idle' | 'loading' | 'done' | 'error';
}

function formatBoolean(value: boolean): string {
  return value ? 'yes' : 'no';
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join('\n') : 'none';
}

function formatTimings(snapshot: DiagnosticsSnapshot): string {
  const timings = snapshot.thumbnailWorkerPerformance;
  if (!timings) {
    return 'disabled';
  }

  const parts: Array<[string, ThumbnailTimingAggregate | null]> = [
    ['memoryHit', timings.memoryHit],
    ['diskHit', timings.diskHit],
    ['workerGeneration', timings.workerGeneration],
    ['endToEnd', timings.endToEnd],
  ];

  return parts
    .map(
      ([label, aggregate]) =>
        `${label}: ${
          aggregate
            ? `count=${aggregate.count}, avgMs=${aggregate.averageMs}, maxMs=${aggregate.maxMs}`
            : 'none'
        }`,
    )
    .join('\n');
}

export function buildDiagnosticsReport(
  snapshot: DiagnosticsSnapshot,
  context: RendererDiagnosticsContext,
): string {
  return [
    'Frame View Diagnostics',
    '',
    'App',
    `version: ${snapshot.appVersion}`,
    `electron: ${snapshot.electronVersion}`,
    `platform: ${snapshot.platform}`,
    `arch: ${snapshot.arch}`,
    `packaged: ${formatBoolean(snapshot.isPackaged)}`,
    '',
    'Current View',
    `folder: ${context.folderName ?? 'none'}`,
    `items: ${context.itemCount}`,
    `recursive: ${formatBoolean(context.recursive)}`,
    `scanState: ${context.scanState}`,
    '',
    'Debug',
    `debugLogging: ${formatBoolean(snapshot.debug.enableDebugLogging)}`,
    `performanceMonitoring: ${formatBoolean(snapshot.debug.enablePerformanceMonitoring)}`,
    '',
    'Thumbnail Worker',
    `workerPath: ${snapshot.thumbnailWorker?.workerPath ?? 'unknown'}`,
    `sharpAvailable: ${formatBoolean(snapshot.thumbnailWorker?.sharpAvailable ?? false)}`,
    `ffmpegAvailable: ${formatBoolean(snapshot.thumbnailWorker?.ffmpegAvailable ?? false)}`,
    `ffmpegExists: ${formatBoolean(snapshot.thumbnailWorker?.ffmpegExists ?? false)}`,
    `ffmpegPath: ${snapshot.thumbnailWorker?.ffmpegPath ?? 'unknown'}`,
    `ffprobeAvailable: ${formatBoolean(snapshot.thumbnailWorker?.ffprobeAvailable ?? false)}`,
    `ffprobeExists: ${formatBoolean(snapshot.thumbnailWorker?.ffprobeExists ?? false)}`,
    `ffprobePath: ${snapshot.thumbnailWorker?.ffprobePath ?? 'unknown'}`,
    `probeErrors: ${snapshot.thumbnailWorker?.probeErrors.length ? '' : 'none'}`,
    ...(snapshot.thumbnailWorker?.probeErrors ?? []),
    '',
    'Thumbnail Pipeline',
    `imageWorkers: ${snapshot.thumbnails.imageWorkerCount}`,
    `videoWorkers: ${snapshot.thumbnails.videoWorkerCount}`,
    `imageQueueDepth: ${snapshot.thumbnails.imageQueueDepth}`,
    `videoQueueDepth: ${snapshot.thumbnails.videoQueueDepth}`,
    `inflightRequests: ${snapshot.thumbnails.inflightRequests}`,
    `memoryCacheHits: ${snapshot.thumbnails.memoryCacheHits}`,
    `diskCacheHits: ${snapshot.thumbnails.diskCacheHits}`,
    `generatedCount: ${snapshot.thumbnails.generatedCount}`,
    `abortedCount: ${snapshot.thumbnails.abortedCount}`,
    `videoExtractionFailureCount: ${snapshot.thumbnails.videoExtractionFailureCount}`,
    `sharpDecodeFailureCount: ${snapshot.thumbnails.sharpDecodeFailureCount}`,
    `workerCrashCount: ${snapshot.thumbnails.workerCrashCount}`,
    `workerRestartCount: ${snapshot.thumbnails.workerRestartCount}`,
    '',
    'Thumbnail Timings',
    formatTimings(snapshot),
    '',
    'Media Tools',
    `ffmpegAvailable: ${formatBoolean(snapshot.mediaTools.ffmpegAvailable)}`,
    `ffprobeAvailable: ${formatBoolean(snapshot.mediaTools.ffprobeAvailable)}`,
    `ffmpegPath: ${snapshot.mediaTools.ffmpegPath ?? 'unknown'}`,
    `ffprobePath: ${snapshot.mediaTools.ffprobePath ?? 'unknown'}`,
    '',
    'Recent Worker Events',
    formatList(snapshot.thumbnails.recentWorkerEvents),
    '',
    'Recent Failures',
    formatList(snapshot.thumbnails.recentFailures),
  ].join('\n');
}
