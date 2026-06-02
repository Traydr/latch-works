import { type JSX, useEffect, useMemo } from 'react';

import type { AppSettings } from '../../../shared/types';
import { FolderGridOverlay } from '../../components/FolderGridOverlay';
import type { BrowserEntry } from '../../utils/browserEntries';
import { toDisplayName } from '../../utils/path';
import { getThumbnailPriorityForRow, getThumbnailRequestSize } from '../../utils/thumbnail';
import { useVirtualGridMetrics } from '../useVirtualGridMetrics';
import { ComicTile } from './ComicTile';
import { FolderTile } from './FolderTile';
import { MediaTile } from './MediaTile';

interface GalleryGridProps {
  browserEntries: {
    at: (index: number) => BrowserEntry | null;
    length: number;
  };
  folderChildrenLoading: boolean;
  folderOverlayOpen: boolean;
  comicMode: boolean;
  excludedRootChildPaths: string[];
  onActivateBrowserEntry: (entry: BrowserEntry) => void;
  onRequestVideoMetadata: (item: Extract<BrowserEntry, { kind: 'media' }>['media']) => void;
  onSelectBrowserEntry: (entry: BrowserEntry) => void;
  onSelectFolder: (folderPath: string) => void;
  onToggleExcludedRootChild: (folderPath: string) => void;
  rootPath: string | null;
  selectedBrowserEntryKey: string | null;
  setFolderOverlayOpen: (open: boolean) => void;
  settings: AppSettings;
}

export function GalleryGrid({
  browserEntries,
  folderChildrenLoading,
  folderOverlayOpen,
  comicMode,
  excludedRootChildPaths,
  onActivateBrowserEntry,
  onRequestVideoMetadata,
  onSelectBrowserEntry,
  onSelectFolder,
  onToggleExcludedRootChild,
  rootPath,
  selectedBrowserEntryKey,
  setFolderOverlayOpen,
  settings,
}: GalleryGridProps): JSX.Element {
  const {
    cardHeight,
    cardWidth,
    columnCount,
    gridWidth,
    mainRef,
    overscanWindow,
    rowStride,
    totalGridHeight,
    viewportWindow,
    windowedItems,
  } = useVirtualGridMetrics(
    browserEntries.length,
    settings.thumbnailSize,
    comicMode ? 'tall' : 'wide',
  );

  const thumbnailRequestSize = useMemo(() => {
    return getThumbnailRequestSize(settings.thumbnailSize);
  }, [settings.thumbnailSize]);

  useEffect(() => {
    for (const slot of windowedItems) {
      const entry = browserEntries.at(slot.index);
      if (!entry || entry.kind !== 'media' || entry.media.mediaType !== 'video') {
        continue;
      }

      onRequestVideoMetadata(entry.media);
    }
  }, [browserEntries, onRequestVideoMetadata, windowedItems]);

  return (
    <>
      {folderOverlayOpen ? (
        <FolderGridOverlay
          rootPath={rootPath}
          activePath={rootPath}
          excludedRootChildPaths={excludedRootChildPaths}
          onSelectFolder={onSelectFolder}
          onToggleExcludedRootChild={onToggleExcludedRootChild}
          onClose={() => setFolderOverlayOpen(false)}
        />
      ) : null}

      <main
        ref={mainRef}
        data-gallery-scroll-container="true"
        className="flex-1 overflow-auto px-3 pb-28 pt-28"
      >
        {browserEntries.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="prism-surface rounded-2xl px-6 py-4 text-sm text-zinc-500 dark:text-zinc-300">
              {rootPath
                ? folderChildrenLoading
                  ? 'Checking folder contents...'
                  : comicMode
                    ? `No comics found in ${toDisplayName(rootPath)}.`
                    : `No media or subfolders found in ${toDisplayName(rootPath)}.`
                : 'Drop a folder or click Open below'}
            </p>
          </div>
        ) : (
          <div
            data-gallery-grid="true"
            data-gallery-columns={columnCount}
            data-gallery-row-height={rowStride}
            className="relative mx-auto"
            style={{
              width: `${gridWidth}px`,
              height: `${totalGridHeight}px`,
            }}
          >
            {windowedItems.map((slot) => {
              const entry = browserEntries.at(slot.index);
              if (!entry) {
                return null;
              }

              const selected = entry.key === selectedBrowserEntryKey;
              if (entry.kind === 'folder') {
                return (
                  <FolderTile
                    key={entry.key}
                    cardHeight={cardHeight}
                    cardWidth={cardWidth}
                    entry={entry}
                    left={slot.left}
                    onActivate={onActivateBrowserEntry}
                    onSelect={onSelectBrowserEntry}
                    selected={selected}
                    top={slot.top}
                  />
                );
              }

              const row = Math.floor(slot.index / columnCount);
              const thumbPriority = getThumbnailPriorityForRow(row, viewportWindow, overscanWindow);

              if (entry.kind === 'comic') {
                return (
                  <ComicTile
                    key={entry.key}
                    cardHeight={cardHeight}
                    cardWidth={cardWidth}
                    entry={entry}
                    left={slot.left}
                    onActivate={onActivateBrowserEntry}
                    onSelect={onSelectBrowserEntry}
                    selected={selected}
                    thumbPriority={thumbPriority}
                    thumbnailRequestSize={thumbnailRequestSize}
                    top={slot.top}
                  />
                );
              }

              return (
                <MediaTile
                  key={entry.key}
                  cardHeight={cardHeight}
                  cardWidth={cardWidth}
                  entry={entry}
                  left={slot.left}
                  onActivate={onActivateBrowserEntry}
                  onSelect={onSelectBrowserEntry}
                  selected={selected}
                  settings={settings}
                  thumbPriority={thumbPriority}
                  thumbnailRequestSize={thumbnailRequestSize}
                  top={slot.top}
                />
              );
            })}
          </div>
        )}
      </main>
    </>
  );
}
