import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { FolderNode } from '../../shared/types';
import { frameViewClient } from '../services/frameViewClient';
import { getParentPath, toDisplayName } from '../utils/path';

interface UseFolderNavigationModelOptions {
  rootPath: string | null;
  runScan: (folderPath: string) => Promise<boolean>;
}

interface UseFolderNavigationModelResult {
  navigationCeilingPath: string | null;
  setNavigationCeilingPath: (path: string | null) => void;
  currentFolderChildren: FolderNode[];
  folderChildrenLoading: boolean;
  siblingFolders: FolderNode[];
  pendingFolderSelectionPath: string | null;
  setPendingFolderSelectionPath: (path: string | null) => void;
  parentFolderPath: string | null;
  canOpenParentFolder: boolean;
  canGoToPreviousFolder: boolean;
  canGoToNextFolder: boolean;
  currentFolderPathLabel: string;
  navigateToFolderAction: (folderPath: string, preferredSelectedFolderPath?: string | null) => void;
  openParentFolderAction: () => void;
  openSiblingFolderAction: (direction: -1 | 1) => void;
}

export function useFolderNavigationModel({
  rootPath,
  runScan,
}: UseFolderNavigationModelOptions): UseFolderNavigationModelResult {
  const [navigationCeilingPath, setNavigationCeilingPath] = useState<string | null>(null);
  const [currentFolderChildren, setCurrentFolderChildren] = useState<FolderNode[]>([]);
  const [folderChildrenLoading, setFolderChildrenLoading] = useState(false);
  const [siblingFolders, setSiblingFolders] = useState<FolderNode[]>([]);
  const [pendingFolderSelectionPath, setPendingFolderSelectionPath] = useState<string | null>(null);
  const folderChildrenRequestIdRef = useRef(0);
  const siblingRequestIdRef = useRef(0);

  const parentFolderPath = useMemo(() => getParentPath(rootPath), [rootPath]);

  const canOpenParentFolder = useMemo(() => {
    if (!rootPath || !parentFolderPath || !navigationCeilingPath) {
      return false;
    }

    const normalize = (value: string): string =>
      value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const parentNormalized = normalize(parentFolderPath);
    const ceilingNormalized = normalize(navigationCeilingPath);

    return (
      parentNormalized === ceilingNormalized || parentNormalized.startsWith(`${ceilingNormalized}/`)
    );
  }, [navigationCeilingPath, parentFolderPath, rootPath]);

  const isAtNavigationRoot = useMemo(() => {
    if (!rootPath || !navigationCeilingPath) {
      return false;
    }

    const normalize = (value: string): string =>
      value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

    return normalize(rootPath) === normalize(navigationCeilingPath);
  }, [navigationCeilingPath, rootPath]);

  const navigateToFolderAction = useCallback(
    (folderPath: string, preferredSelectedFolderPath?: string | null): void => {
      setPendingFolderSelectionPath(preferredSelectedFolderPath ?? null);
      void runScan(folderPath);
    },
    [runScan],
  );

  const openParentFolderAction = useCallback((): void => {
    if (!parentFolderPath || !canOpenParentFolder) {
      return;
    }

    navigateToFolderAction(parentFolderPath, rootPath);
  }, [canOpenParentFolder, navigateToFolderAction, parentFolderPath, rootPath]);

  const openSiblingFolderAction = useCallback(
    (direction: -1 | 1): void => {
      if (!rootPath || siblingFolders.length === 0 || isAtNavigationRoot) {
        return;
      }

      const currentIndex = siblingFolders.findIndex((folder) => folder.path === rootPath);
      if (currentIndex < 0) {
        return;
      }

      const nextFolder = siblingFolders[currentIndex + direction];
      if (!nextFolder) {
        return;
      }

      navigateToFolderAction(nextFolder.path);
    },
    [isAtNavigationRoot, navigateToFolderAction, rootPath, siblingFolders],
  );

  useEffect(() => {
    const requestId = ++folderChildrenRequestIdRef.current;

    if (!rootPath) {
      setCurrentFolderChildren([]);
      setFolderChildrenLoading(false);
      return;
    }

    setFolderChildrenLoading(true);

    void (async () => {
      const children = await frameViewClient.listFolderChildren(rootPath);
      if (folderChildrenRequestIdRef.current !== requestId) {
        return;
      }

      setCurrentFolderChildren(children);

      if (folderChildrenRequestIdRef.current === requestId) {
        setFolderChildrenLoading(false);
      }
    })();
  }, [rootPath]);

  useEffect(() => {
    const requestId = ++siblingRequestIdRef.current;

    if (!rootPath || !parentFolderPath) {
      setSiblingFolders([]);
      return;
    }

    void (async () => {
      const siblings = await frameViewClient.listFolderChildren(parentFolderPath);
      if (siblingRequestIdRef.current !== requestId) {
        return;
      }

      setSiblingFolders(siblings);
    })();
  }, [parentFolderPath, rootPath]);

  const currentSiblingIndex = useMemo(() => {
    if (!rootPath) {
      return -1;
    }

    return siblingFolders.findIndex((folder) => folder.path === rootPath);
  }, [rootPath, siblingFolders]);

  const currentFolderPathLabel = useMemo(() => {
    if (!rootPath) {
      return 'No folder selected';
    }

    const folderName = toDisplayName(rootPath);
    if (!parentFolderPath) {
      return folderName;
    }

    return `${toDisplayName(parentFolderPath)} / ${folderName}`;
  }, [parentFolderPath, rootPath]);

  return {
    navigationCeilingPath,
    setNavigationCeilingPath,
    currentFolderChildren,
    folderChildrenLoading,
    siblingFolders,
    pendingFolderSelectionPath,
    setPendingFolderSelectionPath,
    parentFolderPath,
    canOpenParentFolder,
    canGoToPreviousFolder: !isAtNavigationRoot && currentSiblingIndex > 0,
    canGoToNextFolder:
      !isAtNavigationRoot &&
      currentSiblingIndex >= 0 &&
      currentSiblingIndex < siblingFolders.length - 1,
    currentFolderPathLabel,
    navigateToFolderAction,
    openParentFolderAction,
    openSiblingFolderAction,
  };
}
