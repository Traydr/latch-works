import { useCallback } from 'react';

import type { AppSettings, FileFilterSettings } from '../../shared/types';
import { frameViewClient } from '../services/frameViewClient';

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
  excludedRootChildPaths,
  filters,
  recursive,
  rootPath,
}: {
  excludedRootChildPaths: string[];
  filters: AppSettings['filters'];
  recursive: boolean;
  rootPath: string | null;
}): UseScanActionsResult {
  const runScan = useCallback(
    async (folderPath: string, options?: RunScanOptions): Promise<boolean> => {
      return frameViewClient.startScan({
        rootPath: folderPath,
        recursive: options?.recursive ?? recursive,
        filters: options?.filters ?? filters,
        excludedRootChildPaths: options?.excludedRootChildPaths ?? excludedRootChildPaths,
      });
    },
    [excludedRootChildPaths, filters, recursive],
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
