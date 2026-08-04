import { useEffect, useEffectEvent, useRef } from 'react';

import type { AppSettings, ScanEvent, ThemeMode } from '../../shared/types';
import { frameViewClient } from '../services/frameViewClient';
import { getRootGalleryPreferences } from '../utils/rootPreferences';

interface UseAppBootstrapOptions {
  settingsTheme: ThemeMode;
  initializeSettings: (settings: AppSettings) => void;
  setRecursive: (value: boolean) => void;
  applyScanEvent: (event: ScanEvent) => void;
  setNavigationCeilingPath: (path: string | null) => void;
  setPendingFolderSelectionPath: (path: string | null) => void;
  openFolderAction: () => void;
  refreshCurrentFolderAction: () => void;
  runScan: (
    folderPath: string,
    options?: {
      excludedRootChildPaths?: string[];
      filters?: AppSettings['filters'];
      recursive?: boolean;
    },
  ) => Promise<boolean>;
  scanInputPathAction: (candidatePath: string) => void;
  toggleSettingsAction: () => void;
}

function applyTheme(theme: ThemeMode): void {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const useDark = theme === 'dark' || (theme === 'system' && prefersDark);

  document.documentElement.classList.toggle('dark', useDark);
  document.body.classList.toggle('dark', useDark);
}

export function useAppBootstrap({
  settingsTheme,
  initializeSettings,
  setRecursive,
  applyScanEvent,
  setNavigationCeilingPath,
  setPendingFolderSelectionPath,
  openFolderAction,
  refreshCurrentFolderAction,
  runScan,
  scanInputPathAction,
  toggleSettingsAction,
}: UseAppBootstrapOptions): void {
  const pendingScanEventsRef = useRef<ScanEvent[]>([]);
  const flushFrameIdRef = useRef<number | null>(null);

  const applyScanEventEvent = useEffectEvent(applyScanEvent);
  const initializeSettingsEvent = useEffectEvent(initializeSettings);
  const setRecursiveEvent = useEffectEvent(setRecursive);
  const setNavigationCeilingPathEvent = useEffectEvent(setNavigationCeilingPath);
  const setPendingFolderSelectionPathEvent = useEffectEvent(setPendingFolderSelectionPath);
  const openFolderEvent = useEffectEvent(openFolderAction);
  const refreshCurrentFolderEvent = useEffectEvent(refreshCurrentFolderAction);
  const runScanEvent = useEffectEvent(runScan);
  const scanInputPathEvent = useEffectEvent(scanInputPathAction);
  const toggleSettingsEvent = useEffectEvent(toggleSettingsAction);

  useEffect(() => {
    let mounted = true;
    const flushPendingScanEvents = (): void => {
      flushFrameIdRef.current = null;

      if (pendingScanEventsRef.current.length === 0) {
        return;
      }

      const pendingEvents = pendingScanEventsRef.current;
      pendingScanEventsRef.current = [];

      for (const event of pendingEvents) {
        applyScanEventEvent(event);
      }
    };

    const scheduleScanEventFlush = (): void => {
      if (flushFrameIdRef.current !== null) {
        return;
      }

      flushFrameIdRef.current = window.requestAnimationFrame(flushPendingScanEvents);
    };

    const unsubscribe = frameViewClient.onScanEvent((event) => {
      const pendingEvents = pendingScanEventsRef.current;
      const lastEvent = pendingEvents[pendingEvents.length - 1];

      if (
        event.type === 'progress' &&
        lastEvent?.type === 'progress' &&
        lastEvent.runId === event.runId
      ) {
        pendingEvents[pendingEvents.length - 1] = event;
      } else {
        pendingEvents.push(event);
      }

      scheduleScanEventFlush();
    });

    void (async () => {
      const loadedSettings = await frameViewClient.getSettings();
      if (!loadedSettings) {
        return;
      }
      if (!mounted) {
        return;
      }

      initializeSettingsEvent(loadedSettings);
      applyTheme(loadedSettings.theme);

      if (loadedSettings.rememberLastFolder && loadedSettings.lastFolderPath) {
        setNavigationCeilingPathEvent(loadedSettings.lastFolderPath);
        setPendingFolderSelectionPathEvent(null);
        const rootPreferences = getRootGalleryPreferences(
          loadedSettings,
          loadedSettings.lastFolderPath,
        );
        setRecursiveEvent(loadedSettings.recursiveDefault || rootPreferences.comicMode);
        await runScanEvent(loadedSettings.lastFolderPath, {
          recursive: loadedSettings.recursiveDefault || rootPreferences.comicMode,
          filters: loadedSettings.filters,
          excludedRootChildPaths: rootPreferences.excludedRootChildPaths,
        });
      }
    })();

    return () => {
      mounted = false;

      if (flushFrameIdRef.current !== null) {
        window.cancelAnimationFrame(flushFrameIdRef.current);
        flushFrameIdRef.current = null;
      }

      pendingScanEventsRef.current = [];
      unsubscribe();
      void frameViewClient.cancelScan();
    };
  }, []);

  useEffect(() => {
    applyTheme(settingsTheme);
  }, [settingsTheme]);

  useEffect(() => {
    if (settingsTheme !== 'system') {
      return;
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const onSchemeChange = (): void => {
      applyTheme('system');
    };

    mediaQuery.addEventListener('change', onSchemeChange);
    return () => mediaQuery.removeEventListener('change', onSchemeChange);
  }, [settingsTheme]);

  useEffect(() => {
    const onDragOver = (event: DragEvent): void => {
      event.preventDefault();
    };

    const onDrop = (event: DragEvent): void => {
      event.preventDefault();
      const droppedFile = event.dataTransfer?.files?.[0] as File & { path?: string };
      const rawPath = droppedFile?.path;

      if (!rawPath) {
        return;
      }

      scanInputPathEvent(rawPath);
    };

    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);

    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  useEffect(() => {
    const unsubscribe = frameViewClient.onAppCommand((command) => {
      if (command.type === 'open-folder-dialog') {
        openFolderEvent();
        return;
      }

      if (command.type === 'refresh-current-folder') {
        refreshCurrentFolderEvent();
        return;
      }

      if (command.type === 'toggle-settings') {
        toggleSettingsEvent();
        return;
      }

      if (command.type === 'scan-path') {
        scanInputPathEvent(command.path);
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);
}
