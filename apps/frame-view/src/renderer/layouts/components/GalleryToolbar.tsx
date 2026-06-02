import { type JSX, useEffect, useMemo, useRef, useState } from 'react';

import type { AppSettings, GallerySortMode } from '../../../shared/types';
import { SortMenu } from './SortMenu';

interface GalleryToolbarProps {
  onChangeSortMode: (mode: GallerySortMode) => void;
  onOpenFolder: () => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
  onShuffleRandom: () => void;
  onToggleComicMode: (value: boolean) => void;
  onToggleFolderOverlay: () => void;
  onToggleRecursive: (value: boolean) => void;
  comicMode: boolean;
  recursive: boolean;
  settings: AppSettings;
}

export function GalleryToolbar({
  onChangeSortMode,
  onOpenFolder,
  onOpenSettings,
  onRefresh,
  onShuffleRandom,
  onToggleComicMode,
  onToggleFolderOverlay,
  onToggleRecursive,
  comicMode,
  recursive,
  settings,
}: GalleryToolbarProps): JSX.Element {
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!sortMenuOpen) {
      return undefined;
    }

    const onMouseDown = (event: MouseEvent): void => {
      if (sortMenuRef.current?.contains(event.target as Node)) {
        return;
      }

      setSortMenuOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setSortMenuOpen(false);
      }
    };

    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [sortMenuOpen]);

  const activeSortLabel = useMemo(() => {
    const labels: Record<GallerySortMode, string> = {
      'name-asc': 'A-Z',
      'name-desc': 'Z-A',
      'date-newest': 'Newest',
      'date-oldest': 'Oldest',
      random: 'Random',
    };

    return labels[settings.sortMode];
  }, [settings.sortMode]);

  return (
    <div className="prism-surface absolute bottom-6 left-1/2 z-20 inline-flex max-w-[96vw] -translate-x-1/2 items-center gap-2 overflow-visible px-3 py-2">
      <button type="button" className="prism-btn" onClick={onOpenFolder}>
        Open
      </button>
      <button
        type="button"
        className="prism-btn"
        onClick={onToggleFolderOverlay}
        title="Browse subfolders"
      >
        Folders
      </button>
      <button type="button" className="prism-btn" onClick={onRefresh}>
        Refresh
      </button>
      <div className="h-5 w-px bg-zinc-200 dark:bg-zinc-700" />
      <button
        type="button"
        className={`prism-btn ${recursive ? 'prism-btn-active' : ''}`}
        onClick={() => onToggleRecursive(!recursive)}
      >
        Recursive
      </button>
      <button
        type="button"
        className={`prism-btn ${comicMode ? 'prism-btn-active' : ''}`}
        onClick={() => onToggleComicMode(!comicMode)}
      >
        Comic
      </button>
      <div ref={sortMenuRef} className="relative">
        <SortMenu
          activeSortLabel={activeSortLabel}
          onChangeSortMode={onChangeSortMode}
          onToggleOpen={() => setSortMenuOpen((open) => !open)}
          setSortMenuOpen={setSortMenuOpen}
          sortMenuOpen={sortMenuOpen}
          sortMode={settings.sortMode}
        />
      </div>
      {settings.sortMode === 'random' ? (
        <button type="button" className="prism-btn" onClick={onShuffleRandom}>
          Shuffle
        </button>
      ) : null}
      <div className="h-5 w-px bg-zinc-200 dark:bg-zinc-700" />
      <button type="button" className="prism-btn" onClick={onOpenSettings}>
        Settings
      </button>
    </div>
  );
}
