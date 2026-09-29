import { useCallback } from 'react';

import type { AppSettings, FileFilterSettings } from '../../shared/types';
import { frameViewClient } from '../services/frameViewClient';
import { useAppStore } from '../store/useAppStore';
import { getRootGalleryPreferences } from '../utils/rootPreferences';

interface RunScanOptions {
  excludedRootChildPaths?: string[];
  filters?: FileFilterSettings;
  recursive?: boolean;
}

interface UseScanActionsResult {
  openFolderDialogAction: () => Promise<string | null>;
  refreshCurrentFolderAction: () => void;
  resolveScanInputPathAction: (candidatePath: string) => Promise<string | null>;
  runScan: (folderPath: string, options?: RunScanOptions) => Promise<boolean>;
}

export function useScanActions({
  recursive,
  rootPath,
  settings,
}: {
  /** The session's recursive flag, before the scanned folder's comic mode is applied. */
  recursive: boolean;
  rootPath: string | null;
  settings: AppSettings;
}): UseScanActionsResult {
  const supersedeActiveScan = useAppStore((state) => state.supersedeActiveScan);

  // Resolves once the request has started its scan, after a running scan has been cancelled.
  // Options left out come from the scanned folder's own preferences, not the current folder's.
  const runScan = useCallback(
    async (folderPath: string, options?: RunScanOptions): Promise<boolean> => {
      supersedeActiveScan();
      const preferences = getRootGalleryPreferences(settings, folderPath);

      return frameViewClient.startScan({
        rootPath: folderPath,
        recursive: options?.recursive ?? (recursive || preferences.comicMode),
        filters: options?.filters ?? settings.filters,
        excludedRootChildPaths:
          options?.excludedRootChildPaths ?? preferences.excludedRootChildPaths,
      });
    },
    [recursive, settings, supersedeActiveScan],
  );

  const openFolderDialogAction = useCallback(async (): Promise<string | null> => {
    return frameViewClient.openFolderDialog();
  }, []);

  const refreshCurrentFolderAction = useCallback((): void => {
    if (!rootPath) {
      return;
    }

    void runScan(rootPath);
  }, [rootPath, runScan]);

  const resolveScanInputPathAction = useCallback(
    async (candidatePath: string): Promise<string | null> => {
      return frameViewClient.resolveInputPath(candidatePath);
    },
    [],
  );

  return {
    openFolderDialogAction,
    refreshCurrentFolderAction,
    resolveScanInputPathAction,
    runScan,
  };
}
