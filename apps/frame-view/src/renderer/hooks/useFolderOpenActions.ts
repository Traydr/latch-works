import { useCallback, useRef } from 'react';

import type { AppSettings } from '../../shared/types';
import { getRootGalleryPreferences } from '../utils/rootPreferences';

interface UseFolderOpenActionsOptions {
  openFolderDialog: () => Promise<string | null>;
  recursive: boolean;
  resolveScanInputPath: (candidatePath: string) => Promise<string | null>;
  runScan: (
    folderPath: string,
    options?: {
      excludedRootChildPaths?: string[];
      filters?: AppSettings['filters'];
      recursive?: boolean;
    },
  ) => Promise<boolean>;
  setNavigationCeilingPath: (path: string | null) => void;
  setPendingFolderSelectionPath: (path: string | null) => void;
  settings: AppSettings;
}

/** The two entry points that start a scan: the native dialog and a typed-in path. */
interface FolderOpenActions {
  openFolderAction: () => void;
  scanInputPathAction: (candidatePath: string) => void;
}

export function useFolderOpenActions({
  openFolderDialog,
  recursive,
  resolveScanInputPath,
  runScan,
  setNavigationCeilingPath,
  setPendingFolderSelectionPath,
  settings,
}: UseFolderOpenActionsOptions): FolderOpenActions {
  const startScanAtPath = useCallback(
    async (folderPath: string): Promise<void> => {
      setNavigationCeilingPath(folderPath);
      setPendingFolderSelectionPath(null);
      const preferences = getRootGalleryPreferences(settings, folderPath);
      await runScan(folderPath, {
        excludedRootChildPaths: preferences.excludedRootChildPaths,
        recursive: recursive || preferences.comicMode,
      });
    },
    [recursive, runScan, setNavigationCeilingPath, setPendingFolderSelectionPath, settings],
  );

  const openFolderAction = useCallback((): void => {
    void (async () => {
      const selectedPath = await openFolderDialog();

      if (selectedPath) {
        await startScanAtPath(selectedPath);
      }
    })();
  }, [openFolderDialog, startScanAtPath]);

  const latestInputPathRef = useRef(0);

  // Paths resolve asynchronously, so two handed over back to back (two OS opens) could resolve
  // out of order. Only the newest one is scanned.
  const scanInputPathAction = useCallback(
    (candidatePath: string): void => {
      latestInputPathRef.current += 1;
      const inputPathId = latestInputPathRef.current;

      void (async () => {
        const resolvedPath = await resolveScanInputPath(candidatePath);

        if (resolvedPath && inputPathId === latestInputPathRef.current) {
          await startScanAtPath(resolvedPath);
        }
      })();
    },
    [resolveScanInputPath, startScanAtPath],
  );

  return { openFolderAction, scanInputPathAction };
}
