import { useEffect, useEffectEvent, useRef } from "react";
import { useModeActive } from "../../../../shell/shell";
import type { AppSettings, ScanEvent } from "../../shared/types";
import { frameViewClient } from "../services/frameViewClient";
import { getRootGalleryPreferences } from "../utils/rootPreferences";

interface UseAppBootstrapOptions {
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
      filters?: AppSettings["filters"];
      recursive?: boolean;
    },
  ) => Promise<boolean>;
  scanInputPathAction: (candidatePath: string) => void;
  /** Asks for `file` in the viewer once the scan of `folder` has listed it. */
  focusPathAction: (focus: { folder: string; file: string }) => void;
}

export function useAppBootstrap({
  initializeSettings,
  setRecursive,
  applyScanEvent,
  setNavigationCeilingPath,
  setPendingFolderSelectionPath,
  openFolderAction,
  refreshCurrentFolderAction,
  runScan,
  scanInputPathAction,
  focusPathAction,
}: UseAppBootstrapOptions): void {
  const pendingScanEventsRef = useRef<ScanEvent[]>([]);
  // Set once the OS hands the app a path to open; that path wins over the remembered folder.
  const launchPathRequestedRef = useRef(false);
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
  const focusPathEvent = useEffectEvent(focusPathAction);

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
        event.type === "progress" &&
        lastEvent?.type === "progress" &&
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

      if (
        loadedSettings.rememberLastFolder &&
        loadedSettings.lastFolderPath &&
        !launchPathRequestedRef.current
      ) {
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

  const modeActive = useModeActive();

  useEffect(() => {
    if (!modeActive) {
      return;
    }

    const onDragOver = (event: DragEvent): void => {
      event.preventDefault();
    };

    const onDrop = (event: DragEvent): void => {
      event.preventDefault();
      const droppedFile = event.dataTransfer?.files?.[0];

      if (!droppedFile) {
        return;
      }

      void (async () => {
        // Resolves a dropped file to its parent folder and authorizes it for scanning.
        const droppedFolder = await frameViewClient.authorizeDroppedFile(droppedFile);

        if (droppedFolder) {
          scanInputPathEvent(droppedFolder);
        }
      })();
    };

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);

    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [modeActive]);

  useEffect(() => {
    const unsubscribe = frameViewClient.onAppCommand((command) => {
      if (command.type === "open-folder-dialog") {
        openFolderEvent();

        return;
      }

      if (command.type === "refresh-current-folder") {
        refreshCurrentFolderEvent();

        return;
      }

      if (command.type === "scan-path") {
        launchPathRequestedRef.current = true;

        if (command.focusPath) {
          focusPathEvent({ folder: command.path, file: command.focusPath });
        }

        scanInputPathEvent(command.path);
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);
}
