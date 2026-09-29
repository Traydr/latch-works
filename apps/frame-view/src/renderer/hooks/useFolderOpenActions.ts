import { useCallback, useRef } from 'react';

interface UseFolderOpenActionsOptions {
  openFolderDialog: () => Promise<string | null>;
  resolveScanInputPath: (candidatePath: string) => Promise<string | null>;
  runScan: (folderPath: string) => Promise<boolean>;
  setNavigationCeilingPath: (path: string | null) => void;
  setPendingFolderSelectionPath: (path: string | null) => void;
}

/** The two entry points that start a scan: the native dialog and a typed-in path. */
interface FolderOpenActions {
  openFolderAction: () => void;
  scanInputPathAction: (candidatePath: string) => void;
}

export function useFolderOpenActions({
  openFolderDialog,
  resolveScanInputPath,
  runScan,
  setNavigationCeilingPath,
  setPendingFolderSelectionPath,
}: UseFolderOpenActionsOptions): FolderOpenActions {
  const startScanAtPath = useCallback(
    async (folderPath: string): Promise<void> => {
      setNavigationCeilingPath(folderPath);
      setPendingFolderSelectionPath(null);
      await runScan(folderPath);
    },
    [runScan, setNavigationCeilingPath, setPendingFolderSelectionPath],
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
