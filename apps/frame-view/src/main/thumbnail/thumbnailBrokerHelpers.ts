import { existsSync } from 'node:fs';
import path from 'node:path';

import type { ThumbnailTimingAggregate } from '../../shared/thumbnail';

export interface ThumbnailPerformanceAggregateState {
  count: number;
  maxMs: number;
  totalMs: number;
}

export function nowMs(): number {
  return Date.now();
}

export function createTimingAggregateSnapshot(
  aggregate: ThumbnailPerformanceAggregateState | null,
): ThumbnailTimingAggregate | null {
  if (!aggregate || aggregate.count === 0) {
    return null;
  }

  return {
    averageMs: Math.round((aggregate.totalMs / aggregate.count) * 100) / 100,
    count: aggregate.count,
    maxMs: Math.round(aggregate.maxMs * 100) / 100,
  };
}

export function appendRecentEntry(entries: string[], entry: string, maxEntries: number): void {
  entries.push(`${new Date().toISOString()} ${entry}`);
  if (entries.length > maxEntries) {
    entries.splice(0, entries.length - maxEntries);
  }
}

export function resolveThumbnailWorkerPath(overridePath?: string): {
  checkedPaths: string[];
  resolvedPath: string;
} {
  const candidates = [
    overridePath,
    path.join(__dirname, 'thumbnail.worker.js'),
    process.resourcesPath
      ? path.join(process.resourcesPath, 'app.asar', '.vite', 'build', 'thumbnail.worker.js')
      : null,
    process.resourcesPath
      ? path.join(
          process.resourcesPath,
          'app.asar.unpacked',
          '.vite',
          'build',
          'thumbnail.worker.js',
        )
      : null,
  ].filter((candidate): candidate is string => !!candidate);

  for (const candidatePath of candidates) {
    if (existsSync(candidatePath)) {
      return {
        checkedPaths: candidates,
        resolvedPath: candidatePath,
      };
    }
  }

  throw new Error(`Thumbnail worker entry was not found. Checked: ${candidates.join(', ')}`);
}
