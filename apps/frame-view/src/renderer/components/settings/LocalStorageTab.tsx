import type { JSX } from 'react';

import type { MediaIndexStats, MediaToolsStatus } from '../../../shared/types';
import { SettingsSection } from './SettingsSection';

interface LocalStorageTabProps {
  mediaIndexStats: MediaIndexStats | null;
  mediaToolsStatus: MediaToolsStatus | null;
  onClearMediaIndex: () => void;
  onClearThumbnailCache: () => void;
}

export function LocalStorageTab({
  mediaIndexStats,
  mediaToolsStatus,
  onClearMediaIndex,
  onClearThumbnailCache,
}: LocalStorageTabProps): JSX.Element {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <SettingsSection className="space-y-2">
        <p className="text-zinc-500 dark:text-zinc-400">Thumbnail cache</p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Cached derivatives speed up gallery load times and reduce repeated image/video processing.
        </p>
        <button type="button" className="prism-btn" onClick={onClearThumbnailCache}>
          Clear thumbnail cache
        </button>
      </SettingsSection>

      <SettingsSection className="space-y-2">
        <p className="text-zinc-500 dark:text-zinc-400">Media index (SQLite)</p>
        {mediaIndexStats ? (
          <div className="space-y-1 text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
            <p>{mediaIndexStats.totalItems} indexed item(s)</p>
            <p>{mediaIndexStats.uniqueRoots} root folder(s)</p>
            <p className="break-all">{mediaIndexStats.dbPath}</p>
          </div>
        ) : (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Loading index stats...</p>
        )}
        <button type="button" className="prism-btn" onClick={onClearMediaIndex}>
          Clear media index
        </button>
      </SettingsSection>

      <SettingsSection className="space-y-2 md:col-span-2">
        <p className="text-zinc-500 dark:text-zinc-400">Media tooling</p>
        {mediaToolsStatus ? (
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-zinc-200/70 bg-white/60 p-3 text-xs dark:border-zinc-700/70 dark:bg-zinc-900/40">
              <p>ffmpeg: {mediaToolsStatus.ffmpegAvailable ? 'available' : 'not available'}</p>
              <p className="break-all text-zinc-500 dark:text-zinc-400">
                {mediaToolsStatus.ffmpegPath ?? 'No runtime path'}
              </p>
            </div>
            <div className="rounded-xl border border-zinc-200/70 bg-white/60 p-3 text-xs dark:border-zinc-700/70 dark:bg-zinc-900/40">
              <p>ffprobe: {mediaToolsStatus.ffprobeAvailable ? 'available' : 'not available'}</p>
              <p className="break-all text-zinc-500 dark:text-zinc-400">
                {mediaToolsStatus.ffprobePath ?? 'No runtime path'}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Loading media tooling status...
          </p>
        )}
      </SettingsSection>
    </div>
  );
}
