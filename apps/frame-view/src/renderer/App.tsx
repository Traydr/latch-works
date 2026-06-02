import { type JSX, useCallback, useMemo, useState } from 'react';

import type { AppSettingsPatch, GallerySortMode } from '../shared/types';
import { ComicReader } from './components/ComicReader';
import { SettingsDrawer } from './components/SettingsDrawer';
import { ViewerModal } from './components/ViewerModal';
import { useAppBootstrap } from './hooks/useAppBootstrap';
import { useBrowserSelection } from './hooks/useBrowserSelection';
import { useFolderNavigationModel } from './hooks/useFolderNavigationModel';
import { useGalleryKeyboardNavigation } from './hooks/useGalleryKeyboardNavigation';
import { useScanActions } from './hooks/useScanActions';
import { useSettingsActions } from './hooks/useSettingsActions';
import { useSettingsPanelData } from './hooks/useSettingsPanelData';
import { useVideoMetadataQueue } from './hooks/useVideoMetadataQueue';
import type { LayoutShellProps } from './layouts';
import { PrismLayout } from './layouts';
import { useAppStore } from './store/useAppStore';
import { buildBrowserEntryCollection } from './utils/browserEntries';
import type { ComicEntry } from './utils/comics';
import { buildComicEntries, sortComicEntries } from './utils/comics';
import { toDisplayName } from './utils/path';
import {
  createRootGalleryPreferencesPatch,
  getRootGalleryPreferences,
  toggleExcludedRootChildPath,
} from './utils/rootPreferences';
import { createRandomSeed } from './utils/sort';

function AppInner(): JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeComic, setActiveComic] = useState<ComicEntry | null>(null);

  const settings = useAppStore((state) => state.settings);
  const rootPath = useAppStore((state) => state.rootPath);
  const recursive = useAppStore((state) => state.recursive);
  const items = useAppStore((state) => state.items);
  const loadingChunks = useAppStore((state) => state.loadingChunks);
  const viewerItemsSnapshot = useAppStore((state) => state.viewerItemsSnapshot);
  const selectedId = useAppStore((state) => state.selectedId);
  const viewerIndex = useAppStore((state) => state.viewerIndex);
  const activeScanRunId = useAppStore((state) => state.activeScanRunId);
  const scanMessage = useAppStore((state) => state.scanMessage);
  const scanState = useAppStore((state) => state.scanState);

  const initializeSettings = useAppStore((state) => state.initializeSettings);
  const setRecursive = useAppStore((state) => state.setRecursive);
  const setSelectedId = useAppStore((state) => state.setSelectedId);
  const openViewerAt = useAppStore((state) => state.openViewerAt);
  const closeViewer = useAppStore((state) => state.closeViewer);
  const shiftViewer = useAppStore((state) => state.shiftViewer);
  const applyScanEvent = useAppStore((state) => state.applyScanEvent);
  const applyVideoMetadata = useAppStore((state) => state.applyVideoMetadata);

  const rootGalleryPreferences = useMemo(() => {
    return getRootGalleryPreferences(settings, rootPath);
  }, [rootPath, settings]);
  const comicMode = rootGalleryPreferences.comicMode;
  const effectiveRecursive = recursive || comicMode;

  const {
    openFolderDialogAction,
    refreshCurrentFolderAction,
    resolveScanInputPathAction,
    runScan,
  } = useScanActions({
    excludedRootChildPaths: rootGalleryPreferences.excludedRootChildPaths,
    filters: settings.filters,
    recursive: effectiveRecursive,
    rootPath,
  });

  const {
    navigationCeilingPath,
    setNavigationCeilingPath,
    currentFolderChildren,
    folderChildrenLoading,
    pendingFolderSelectionPath,
    setPendingFolderSelectionPath,
    parentFolderPath,
    canOpenParentFolder,
    canGoToPreviousFolder,
    canGoToNextFolder,
    currentFolderPathLabel,
    navigateToFolderAction,
    openParentFolderAction,
    openSiblingFolderAction,
  } = useFolderNavigationModel({
    rootPath,
    runScan,
  });

  const openFolderAction = useCallback((): void => {
    void (async () => {
      const selectedPath = await openFolderDialogAction();
      if (!selectedPath) {
        return;
      }

      setNavigationCeilingPath(selectedPath);
      setPendingFolderSelectionPath(null);
      const selectedPreferences = getRootGalleryPreferences(settings, selectedPath);
      await runScan(selectedPath, {
        excludedRootChildPaths: selectedPreferences.excludedRootChildPaths,
        recursive: recursive || selectedPreferences.comicMode,
      });
    })();
  }, [
    openFolderDialogAction,
    recursive,
    runScan,
    setNavigationCeilingPath,
    setPendingFolderSelectionPath,
    settings,
  ]);

  const scanInputPathAction = useCallback(
    (candidatePath: string): void => {
      void (async () => {
        const resolvedPath = await resolveScanInputPathAction(candidatePath);
        if (!resolvedPath) {
          return;
        }

        setNavigationCeilingPath(resolvedPath);
        setPendingFolderSelectionPath(null);
        const resolvedPreferences = getRootGalleryPreferences(settings, resolvedPath);
        await runScan(resolvedPath, {
          excludedRootChildPaths: resolvedPreferences.excludedRootChildPaths,
          recursive: recursive || resolvedPreferences.comicMode,
        });
      })();
    },
    [
      recursive,
      resolveScanInputPathAction,
      runScan,
      setNavigationCeilingPath,
      setPendingFolderSelectionPath,
      settings,
    ],
  );

  const comicEntries = useMemo(() => {
    return comicMode && scanState !== 'loading'
      ? sortComicEntries(buildComicEntries(items, rootPath), settings.sortMode, settings.randomSeed)
      : [];
  }, [comicMode, items, rootPath, scanState, settings.randomSeed, settings.sortMode]);

  const browserEntries = useMemo(() => {
    return buildBrowserEntryCollection(
      currentFolderChildren,
      comicEntries,
      items,
      loadingChunks,
      effectiveRecursive,
      comicMode,
      settings.sortMode,
      scanState === 'loading',
    );
  }, [
    comicEntries,
    comicMode,
    currentFolderChildren,
    effectiveRecursive,
    items,
    loadingChunks,
    scanState,
    settings.sortMode,
  ]);

  const {
    activateBrowserEntryAction,
    selectBrowserEntryAction,
    selectedBrowserEntry,
    selectedBrowserEntryIndex,
    selectedBrowserEntryKey,
  } = useBrowserSelection({
    browserEntries,
    navigateToFolderAction,
    openComicReader: setActiveComic,
    openViewerAt,
    pendingFolderSelectionPath,
    selectedId,
    setPendingFolderSelectionPath,
    setSelectedId,
  });

  const requestVideoMetadataAction = useVideoMetadataQueue({
    activeScanRunId,
    applyVideoMetadata,
  });

  const { diagnosticsSnapshot, mediaIndexStats, mediaToolsStatus, refreshSettingsPanelData } =
    useSettingsPanelData(settingsOpen);
  const {
    cacheStatusMessage,
    clearMediaIndexAction,
    clearThumbnailCacheAction,
    copyDiagnosticsAction,
    refreshDiagnosticsAction,
    updateSettings,
  } = useSettingsActions({
    initializeSettings,
    mediaEntryCount: browserEntries.mediaEntryCount,
    recursive: effectiveRecursive,
    refreshSettingsPanelData,
    rootPath,
    runScan,
    scanState,
  });

  useAppBootstrap({
    settingsTheme: settings.theme,
    initializeSettings,
    setRecursive,
    applyScanEvent,
    setNavigationCeilingPath,
    setPendingFolderSelectionPath,
    openFolderAction,
    refreshCurrentFolderAction,
    runScan,
    scanInputPathAction,
    toggleSettingsAction: () => setSettingsOpen((open) => !open),
  });

  const changeSortModeAction = useCallback(
    (mode: GallerySortMode): void => {
      void updateSettings({ sortMode: mode });
    },
    [updateSettings],
  );

  const shuffleRandomAction = useCallback((): void => {
    void updateSettings({ randomSeed: createRandomSeed() });
  }, [updateSettings]);

  useGalleryKeyboardNavigation({
    viewerIndex,
    settingsOpen,
    browserEntries,
    selectedBrowserEntry,
    selectedBrowserEntryIndex,
    selectBrowserEntryAction,
    activateBrowserEntryAction,
    openParentFolderAction,
    openSiblingFolderAction,
    navigateToFolderAction,
  });

  const activeViewerItems = viewerItemsSnapshot ?? items;
  const canStepViewerBackward =
    settings.loopViewerNavigation || viewerIndex === null || viewerIndex > 0;
  const canStepViewerForward =
    settings.loopViewerNavigation ||
    viewerIndex === null ||
    (activeViewerItems.length > 0 && viewerIndex < activeViewerItems.length - 1);

  const layoutProps: LayoutShellProps = {
    settings,
    rootPath,
    sidebarRootPath: navigationCeilingPath,
    scanMessage,
    scanState,
    recursive: effectiveRecursive,
    comicMode,
    folderChildrenLoading,
    browserEntries,
    selectedBrowserEntryKey,
    selectedBrowserEntryIndex,
    comicEntryCount: browserEntries.comicEntryCount,
    excludedRootChildPaths: rootGalleryPreferences.excludedRootChildPaths,
    folderEntryCount: browserEntries.folderEntryCount,
    mediaEntryCount: browserEntries.mediaEntryCount,
    currentFolderPathLabel,
    parentFolderPath,
    canOpenParentFolder,
    canGoToPreviousFolder,
    canGoToNextFolder,
    cacheStatusMessage,
    onOpenFolder: openFolderAction,
    onRefresh: refreshCurrentFolderAction,
    onToggleRecursive: (value: boolean) => {
      setRecursive(value);
      void updateSettings({ recursiveDefault: value });
      if (rootPath) {
        void runScan(rootPath, {
          recursive: value || comicMode,
          excludedRootChildPaths: rootGalleryPreferences.excludedRootChildPaths,
        });
      }
    },
    onToggleComicMode: (value: boolean) => {
      if (!rootPath) {
        return;
      }

      const nextPreferences = {
        ...rootGalleryPreferences,
        comicMode: value,
      };
      void updateSettings(createRootGalleryPreferencesPatch(settings, rootPath, nextPreferences));
      if (value) {
        setRecursive(true);
      } else {
        setActiveComic(null);
      }
      void runScan(rootPath, {
        recursive: value || recursive,
        excludedRootChildPaths: nextPreferences.excludedRootChildPaths,
      });
    },
    onToggleExcludedRootChild: (folderPath: string) => {
      if (!rootPath) {
        return;
      }

      const nextPreferences = toggleExcludedRootChildPath(rootGalleryPreferences, folderPath);
      void updateSettings(createRootGalleryPreferencesPatch(settings, rootPath, nextPreferences));
      if (effectiveRecursive) {
        void runScan(rootPath, {
          recursive: effectiveRecursive,
          excludedRootChildPaths: nextPreferences.excludedRootChildPaths,
        });
      }
    },
    onChangeSortMode: changeSortModeAction,
    onShuffleRandom: shuffleRandomAction,
    onOpenSettings: () => setSettingsOpen(true),
    onRequestVideoMetadata: requestVideoMetadataAction,
    onSelectFolder: navigateToFolderAction,
    onSelectBrowserEntry: selectBrowserEntryAction,
    onActivateBrowserEntry: activateBrowserEntryAction,
    onOpenParentFolder: openParentFolderAction,
    onOpenPreviousFolder: () => openSiblingFolderAction(-1),
    onOpenNextFolder: () => openSiblingFolderAction(1),
  };

  const handleSettingsUpdate = useCallback(
    (patch: AppSettingsPatch): void => {
      void updateSettings(patch);
    },
    [updateSettings],
  );

  return (
    <>
      <PrismLayout {...layoutProps} />

      {viewerIndex !== null ? (
        <ViewerModal
          items={activeViewerItems}
          index={viewerIndex}
          autoplayVideos={settings.autoplayVideos}
          loopVideos={settings.loopVideos}
          canStepBackward={canStepViewerBackward}
          canStepForward={canStepViewerForward}
          onClose={closeViewer}
          onStep={(delta) => shiftViewer(delta, settings.loopViewerNavigation)}
        />
      ) : null}

      {activeComic ? (
        <ComicReader comic={activeComic} onClose={() => setActiveComic(null)} />
      ) : null}

      <SettingsDrawer
        isOpen={settingsOpen}
        currentFolderSummary={{
          folderName: rootPath ? toDisplayName(rootPath) : null,
          itemCount: browserEntries.mediaEntryCount,
          recursive: effectiveRecursive,
          scanState,
        }}
        diagnosticsSnapshot={diagnosticsSnapshot}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onUpdate={handleSettingsUpdate}
        mediaIndexStats={mediaIndexStats}
        mediaToolsStatus={mediaToolsStatus}
        onCopyDiagnostics={copyDiagnosticsAction}
        onRefreshDiagnostics={refreshDiagnosticsAction}
        onClearThumbnailCache={clearThumbnailCacheAction}
        onClearMediaIndex={clearMediaIndexAction}
      />
    </>
  );
}

export function App(): JSX.Element {
  return <AppInner />;
}
