import { type JSX, useCallback, useEffect, useRef, useState } from 'react';

import type { FolderNode } from '../../shared/types';
import { getFrameViewValue } from '../utils/frameViewResult';
import { toDisplayName } from '../utils/path';

interface FolderGridOverlayProps {
  /** Root path to show children for */
  rootPath: string | null;
  /** Currently active/scanned folder path */
  activePath: string | null;
  /** Called when user selects a folder */
  onSelectFolder: (folderPath: string) => void;
  /** Direct children of the opened root excluded from recursive scans */
  excludedRootChildPaths: string[];
  /** Called when user toggles a root child scan exclusion */
  onToggleExcludedRootChild: (folderPath: string) => void;
  /** Called when overlay should close */
  onClose: () => void;
}

export function FolderGridOverlay({
  rootPath,
  activePath,
  onSelectFolder,
  excludedRootChildPaths,
  onToggleExcludedRootChild,
  onClose,
}: FolderGridOverlayProps): JSX.Element {
  const [currentPath, setCurrentPath] = useState<string | null>(rootPath);
  const [folders, setFolders] = useState<FolderNode[]>([]);
  const [pendingLoadRequestId, setPendingLoadRequestId] = useState<number | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<{ path: string; name: string }[]>([]);
  const loadRequestIdRef = useRef(0);

  const loadFolder = useCallback(async (folderPath: string): Promise<void> => {
    const requestId = ++loadRequestIdRef.current;
    setPendingLoadRequestId(requestId);
    try {
      const nodes = getFrameViewValue(
        await window.frameView.listFolderChildren(folderPath),
        'list-folder-children',
      );
      if (requestId !== loadRequestIdRef.current) {
        return;
      }

      setFolders(nodes ?? []);
    } finally {
      setPendingLoadRequestId((currentRequestId) =>
        currentRequestId === requestId ? null : currentRequestId,
      );
    }
  }, []);

  // Load initial folder
  useEffect(() => {
    if (!rootPath) return;
    setCurrentPath(rootPath);
    setBreadcrumbs([{ path: rootPath, name: toDisplayName(rootPath) }]);
    void loadFolder(rootPath);
  }, [rootPath, loadFolder]);

  useEffect(() => {
    return () => {
      loadRequestIdRef.current += 1;
    };
  }, []);

  useEffect(() => {
    document.body.dataset.frameViewFolderOverlay = 'open';
    return () => {
      delete document.body.dataset.frameViewFolderOverlay;
    };
  }, []);

  const navigateToFolder = useCallback(
    (folderPath: string, folderName: string) => {
      setCurrentPath(folderPath);
      setBreadcrumbs((prev) => {
        // If we're navigating back to an existing breadcrumb, truncate
        const existingIndex = prev.findIndex((b) => b.path === folderPath);
        if (existingIndex >= 0) {
          return prev.slice(0, existingIndex + 1);
        }
        return [...prev, { path: folderPath, name: folderName }];
      });
      void loadFolder(folderPath);
    },
    [loadFolder],
  );

  const selectAndClose = useCallback(
    (folderPath: string) => {
      onSelectFolder(folderPath);
      onClose();
    },
    [onSelectFolder, onClose],
  );

  const goBack = useCallback(() => {
    if (breadcrumbs.length <= 1) {
      return;
    }

    const parent = breadcrumbs[breadcrumbs.length - 2];
    if (!parent) {
      return;
    }

    navigateToFolder(parent.path, parent.name);
  }, [breadcrumbs, navigateToFolder]);

  const excludedRootChildPathSet = new Set(excludedRootChildPaths);
  const isShowingOpenedRoot = currentPath === rootPath;
  const loading = pendingLoadRequestId !== null;

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/35 backdrop-blur-sm">
      <button
        type="button"
        className="absolute inset-0"
        onClick={onClose}
        aria-label="Close folder browser"
      />

      <div className="prism-surface z-10 mx-6 flex max-h-[72vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl">
        {/* Header with breadcrumbs */}
        <div className="flex items-center gap-2 border-b border-inherit px-5 py-3">
          <svg
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-5 w-5 flex-shrink-0 text-amber-500"
          >
            <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
          </svg>
          <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-sm">
            {breadcrumbs.map((crumb, i) => {
              const isLast = i === breadcrumbs.length - 1;
              return (
                <span key={crumb.path} className="flex items-center gap-1">
                  {i > 0 ? <span className="text-zinc-400 dark:text-zinc-500">/</span> : null}
                  <button
                    type="button"
                    className={`truncate whitespace-nowrap transition ${
                      isLast
                        ? 'font-medium text-zinc-800 dark:text-zinc-100'
                        : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100'
                    }`}
                    onClick={() => navigateToFolder(crumb.path, crumb.name)}
                  >
                    {crumb.name}
                  </button>
                </span>
              );
            })}
          </nav>
          <button
            type="button"
            className={`prism-btn flex-shrink-0 ${breadcrumbs.length <= 1 ? 'pointer-events-none opacity-45' : ''}`}
            onClick={goBack}
          >
            Back
          </button>
          {currentPath ? (
            <button
              type="button"
              className="prism-btn flex-shrink-0"
              onClick={() => selectAndClose(currentPath)}
            >
              Open
            </button>
          ) : null}
          <button type="button" className="prism-btn flex-shrink-0" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Folder grid */}
        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-sm text-zinc-500 dark:text-zinc-400">
              Loading...
            </div>
          ) : folders.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-zinc-500 dark:text-zinc-400">
              <p className="text-sm">No subfolders</p>
              {currentPath ? (
                <button
                  type="button"
                  className="prism-btn"
                  onClick={() => selectAndClose(currentPath)}
                >
                  Open this folder
                </button>
              ) : null}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
              {folders.map((folder) => {
                const isActive = folder.path === activePath;
                const isExcluded = isShowingOpenedRoot && excludedRootChildPathSet.has(folder.path);
                return (
                  <div
                    key={folder.path}
                    className={`flex flex-col gap-2 rounded-xl border p-3 transition ${
                      isActive
                        ? 'border-violet-300 bg-violet-50/95 text-violet-700 shadow-sm dark:border-violet-500/50 dark:bg-violet-500/20 dark:text-violet-200'
                        : isExcluded
                          ? 'border-zinc-300/80 bg-zinc-100/80 text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-500'
                          : 'border-zinc-300/80 bg-white/70 text-zinc-700 shadow-sm hover:border-zinc-400 hover:bg-white dark:border-zinc-700/80 dark:bg-zinc-900/70 dark:text-zinc-200 dark:hover:border-zinc-600 dark:hover:bg-zinc-900/95'
                    }`}
                    title={folder.path}
                  >
                    <button
                      type="button"
                      className="flex min-h-[74px] flex-col items-center gap-2"
                      onClick={() => navigateToFolder(folder.path, folder.name)}
                      onDoubleClick={() => selectAndClose(folder.path)}
                      title={`Click to browse into, double-click to open\n${folder.path}`}
                    >
                      <svg
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        className={`h-8 w-8 ${isExcluded ? 'text-zinc-400 dark:text-zinc-600' : 'text-amber-500'}`}
                      >
                        <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                      </svg>
                      <span className="w-full truncate text-center text-xs font-medium">
                        {folder.name}
                      </span>
                    </button>
                    {isShowingOpenedRoot ? (
                      <button
                        type="button"
                        className={`prism-btn justify-center text-[11px] ${
                          isExcluded
                            ? 'prism-btn-excluded bg-red-50/80 text-red-700 dark:bg-red-950/25 dark:text-red-200'
                            : ''
                        }`}
                        onClick={() => onToggleExcludedRootChild(folder.path)}
                      >
                        {isExcluded ? 'Excluded' : 'Included'}
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="border-t border-inherit px-4 py-2 text-[10px] text-zinc-500 dark:text-zinc-400">
          Click to browse into folder · Double-click to open and scan
        </div>
      </div>
    </div>
  );
}
