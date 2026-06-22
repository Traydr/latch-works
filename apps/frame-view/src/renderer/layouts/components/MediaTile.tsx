import type { JSX } from 'react';

import type { AppSettings } from '../../../shared/types';
import type { BrowserEntry } from '../../utils/browserEntries';
import { formatBytes, toFileUrl, toThumbnailUrl } from '../../utils/path';

interface MediaTileProps {
  cardHeight: number;
  cardWidth: number;
  entry: Extract<BrowserEntry, { kind: 'media' }>;
  left: number;
  onActivate: (entry: BrowserEntry) => void;
  onSelect: (entry: BrowserEntry) => void;
  selected: boolean;
  settings: AppSettings;
  thumbPriority: 0 | 1 | 2;
  thumbnailRequestSize: number;
  top: number;
}

export function MediaTile({
  cardHeight,
  cardWidth,
  entry,
  left,
  onActivate,
  onSelect,
  selected,
  settings,
  thumbPriority,
  thumbnailRequestSize,
  top,
}: MediaTileProps): JSX.Element {
  const item = entry.media;
  const thumbUrl = toThumbnailUrl(item.path, thumbnailRequestSize, thumbPriority);

  return (
    <button
      type="button"
      data-gallery-item="true"
      data-gallery-item-id={entry.key}
      data-gallery-item-video={item.mediaType === 'video' ? 'true' : undefined}
      className={`group absolute overflow-hidden rounded-2xl text-left transition active:scale-[0.96] [outline:1px_solid_rgba(0,0,0,0.1)] dark:[outline:1px_solid_rgba(255,255,255,0.1)] ${
        selected
          ? 'ring-2 ring-violet-500 ring-offset-2 ring-offset-zinc-50 dark:ring-offset-zinc-950'
          : 'hover:shadow-lg'
      }`}
      onClick={() => onSelect(entry)}
      onDoubleClick={() => onActivate(entry)}
      onMouseEnter={(event) => {
        if (!settings.autoplayOnHover || item.mediaType !== 'video') {
          return;
        }

        const video = event.currentTarget.querySelector('video');
        if (!video) {
          return;
        }

        void video.play().catch(() => {
          // Ignore autoplay failures.
        });
      }}
      onMouseLeave={(event) => {
        if (item.mediaType !== 'video') {
          return;
        }

        const video = event.currentTarget.querySelector('video');
        if (!video) {
          return;
        }

        video.pause();
        video.currentTime = 0;
      }}
      style={{
        width: `${cardWidth}px`,
        height: `${cardHeight}px`,
        left: `${left}px`,
        top: `${top}px`,
      }}
    >
      <div className="relative h-full w-full bg-zinc-200 dark:bg-zinc-800">
        {item.mediaType === 'image' ? (
          <img
            src={thumbUrl}
            alt={item.name}
            loading="eager"
            decoding="async"
            className="h-full w-full object-cover"
          />
        ) : (
          <video
            src={settings.autoplayOnHover ? toFileUrl(item.path) : undefined}
            poster={thumbUrl}
            muted={!settings.previewAudioEnabled}
            preload="none"
            playsInline
            loop={settings.loopVideos}
            className="h-full w-full object-cover"
          />
        )}
        <div className="absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100">
          <div className="px-3 pb-3">
            <p className="truncate text-sm font-semibold text-white">{item.name}</p>
            <p className="text-[11px] text-white/70">
              {formatBytes(item.size)}
              {item.width && item.height ? ` · ${item.width}×${item.height}` : ''}
            </p>
          </div>
        </div>
        {item.mediaType === 'video' ? (
          <span className="absolute right-2 top-2 rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
            VIDEO
          </span>
        ) : null}
      </div>
    </button>
  );
}
