import {
  FolderOpen,
  Folders,
  ImageIcon,
  ListTree,
  RefreshCcw,
  Settings,
  Shuffle,
} from 'lucide-react';
import { type JSX, useEffect, useMemo, useRef, useState } from 'react';

import type { AppSettings, GallerySortMode } from '../../../shared/types';
import { SortMenu } from './SortMenu';

interface GalleryToolbarProps {
  /** The opened root has child folders excluded from recursive scans: Folders shows a dot. */
  excludesActive: boolean;
  /** Comic grouping and recursive browsing need an opened folder to act on. */
  hasRootFolder: boolean;
  isRefreshing: boolean;
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

function toolButtonClass(active = false): string {
  return `prism-btn inline-flex items-center gap-2 whitespace-nowrap ${active ? 'prism-btn-active' : ''}`;
}

export function GalleryToolbar({
  excludesActive,
  hasRootFolder,
  isRefreshing,
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
      if (event.target instanceof Node && sortMenuRef.current?.contains(event.target)) {
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
    const labels = {
      'name-asc': 'A-Z',
      'name-desc': 'Z-A',
      'date-newest': 'Newest',
      'date-oldest': 'Oldest',
      random: 'Random',
    } satisfies Record<GallerySortMode, string>;

    return labels[settings.sortMode];
  }, [settings.sortMode]);

  return (
    <div className="prism-surface absolute bottom-6 left-1/2 z-20 inline-flex max-w-[96vw] -translate-x-1/2 items-center gap-2 overflow-visible px-3 py-2">
      <button
        type="button"
        className={toolButtonClass()}
        onClick={onOpenFolder}
        title="Open a folder"
      >
        <FolderOpen className="size-4" />
        Open
      </button>
      <button
        type="button"
        className={`${toolButtonClass()} relative`}
        onClick={onToggleFolderOverlay}
        title={excludesActive ? 'Browse subfolders (some are excluded)' : 'Browse subfolders'}
      >
        <Folders className="size-4" />
        Folders
        {excludesActive ? (
          <span
            aria-hidden="true"
            className="absolute -top-1 -right-1 size-2 rounded-full bg-violet-500"
          />
        ) : null}
      </button>
      <div className="h-5 w-px bg-zinc-200 dark:bg-zinc-700" />
      <button
        type="button"
        aria-pressed={recursive}
        className={toolButtonClass(recursive)}
        disabled={!hasRootFolder}
        onClick={() => onToggleRecursive(!recursive)}
        title={hasRootFolder ? 'Recursive browsing' : 'Open a folder to enable recursive browsing'}
      >
        <ListTree className="size-4" />
        Recursive
      </button>
      <button
        type="button"
        aria-pressed={comicMode}
        className={toolButtonClass(comicMode)}
        disabled={!hasRootFolder}
        onClick={() => onToggleComicMode(!comicMode)}
        title={hasRootFolder ? 'Comic grouping' : 'Open a folder for comic grouping'}
      >
        <ImageIcon className="size-4" />
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
        <button
          type="button"
          className={toolButtonClass()}
          onClick={onShuffleRandom}
          title="Shuffle again"
        >
          <Shuffle className="size-4" />
          Shuffle
        </button>
      ) : null}
      <div className="h-5 w-px bg-zinc-200 dark:bg-zinc-700" />
      <button
        type="button"
        className={toolButtonClass()}
        disabled={isRefreshing}
        onClick={onRefresh}
        title="Refresh"
      >
        <RefreshCcw className={`size-4 ${isRefreshing ? 'animate-spin' : ''}`} />
        {isRefreshing ? 'Refreshing' : 'Refresh'}
      </button>
      <div className="h-5 w-px bg-zinc-200 dark:bg-zinc-700" />
      <button
        type="button"
        className={toolButtonClass()}
        onClick={onOpenSettings}
        title="Preferences"
      >
        <Settings className="size-4" />
        Settings
      </button>
    </div>
  );
}
