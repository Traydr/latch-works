import { describe, expect, it } from 'vitest';

import { buildDiagnosticsReport } from '../../../src/renderer/utils/diagnostics';

describe('diagnostics renderer helpers', () => {
  it('builds a readable diagnostics report', () => {
    const report = buildDiagnosticsReport(
      {
        appVersion: '1.0.10',
        arch: 'x64',
        currentFolder: null,
        debug: {
          enableDebugLogging: true,
          enablePerformanceMonitoring: true,
        },
        electronVersion: '40.2.1',
        isPackaged: true,
        mediaTools: {
          ffmpegAvailable: true,
          ffmpegPath: 'C:\\ffmpeg.exe',
          ffprobeAvailable: true,
          ffprobePath: 'C:\\ffprobe.exe',
        },
        platform: 'win32',
        thumbnails: {
          abortedCount: 2,
          diskCacheHits: 9,
          generatedCount: 12,
          imageQueueDepth: 3,
          imageWorkerCount: 2,
          inflightRequests: 4,
          memoryCacheHits: 7,
          recentFailures: ['2026-04-03T00:00:00.000Z failure'],
          recentWorkerEvents: ['2026-04-03T00:00:00.000Z worker ready'],
          sharpDecodeFailureCount: 1,
          timings: {
            diskHit: { averageMs: 12, count: 4, maxMs: 20 },
            endToEnd: { averageMs: 80, count: 6, maxMs: 120 },
            memoryHit: { averageMs: 4, count: 3, maxMs: 6 },
            workerGeneration: { averageMs: 60, count: 5, maxMs: 90 },
          },
          videoExtractionFailureCount: 0,
          videoQueueDepth: 1,
          videoWorkerCount: 1,
          workerCrashCount: 0,
          workerRestartCount: 0,
        },
        thumbnailWorker: {
          ffmpegAvailable: true,
          ffmpegExists: true,
          ffmpegPath: 'C:\\ffmpeg.exe',
          ffprobeAvailable: true,
          ffprobeExists: true,
          ffprobePath: 'C:\\ffprobe.exe',
          probeErrors: [],
          sharpAvailable: true,
          workerPath: 'C:\\thumbnail.worker.js',
        },
        thumbnailWorkerPerformance: {
          diskHit: { averageMs: 12, count: 4, maxMs: 20 },
          endToEnd: { averageMs: 80, count: 6, maxMs: 120 },
          memoryHit: { averageMs: 4, count: 3, maxMs: 6 },
          workerGeneration: { averageMs: 60, count: 5, maxMs: 90 },
        },
      },
      {
        folderName: 'nsfw',
        itemCount: 7472,
        recursive: true,
        scanState: 'done',
      },
    );

    expect(report).toContain('Frame View Diagnostics');
    expect(report).toContain('folder: nsfw');
    expect(report).toContain('ffmpegPath: C:\\ffmpeg.exe');
    expect(report).toContain('Recent Failures');
  });
});
