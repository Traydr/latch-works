import type { AppSettings, GallerySortMode, MediaItem } from '../../shared/types';
import type { BrowserEntry, BrowserEntryCollection } from '../utils/browserEntries';

/**
 * Props passed from App.tsx to each layout shell.
 * Each layout arranges these into its own unique structure.
 */
export interface LayoutShellProps {
  /* data */
  settings: AppSettings;
  rootPath: string | null;
  sidebarRootPath: string | null;
  scanMessage: string;
  scanState: 'idle' | 'loading' | 'done' | 'error';
  recursive: boolean;
  comicMode: boolean;
  folderChildrenLoading: boolean;
  browserEntries: BrowserEntryCollection;
  selectedBrowserEntryKey: string | null;
  selectedBrowserEntryIndex: number;
  comicEntryCount: number;
  excludedRootChildPaths: string[];
  folderEntryCount: number;
  mediaEntryCount: number;
  currentFolderPathLabel: string;
  parentFolderPath: string | null;
  canOpenParentFolder: boolean;
  canGoToPreviousFolder: boolean;
  canGoToNextFolder: boolean;
  cacheStatusMessage: string | null;

  /* actions */
  onOpenFolder: () => void;
  onRefresh: () => void;
  onToggleRecursive: (value: boolean) => void;
  onToggleComicMode: (value: boolean) => void;
  onToggleExcludedRootChild: (folderPath: string) => void;
  onChangeSortMode: (mode: GallerySortMode) => void;
  onShuffleRandom: () => void;
  onOpenSettings: () => void;
  onRequestVideoMetadata: (item: MediaItem) => void;
  onSelectFolder: (folderPath: string) => void;
  onSelectBrowserEntry: (entry: BrowserEntry) => void;
  onActivateBrowserEntry: (entry: BrowserEntry) => void;
  onOpenParentFolder: () => void;
  onOpenPreviousFolder: () => void;
  onOpenNextFolder: () => void;
}
