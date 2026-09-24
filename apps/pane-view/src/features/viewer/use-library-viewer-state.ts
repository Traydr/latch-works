import { useCallback, useEffect, useRef, useState } from "react";
import { VIEWER_STATE_SAVE_INTERVAL_MS } from "./viewer-resume";
import { getViewerState, saveViewerState, type ViewerStateSnapshot } from "./viewer-state-service";

export interface ViewerStatePatch {
  page?: number;
  positionMs?: number;
}

export interface ViewerStateSubject {
  subjectId: string;
  subjectType: "library_entry";
}

export interface ViewerStateWrite extends ViewerStateSubject {
  page?: number;
  positionMs?: number;
}

/**
 * The two viewer-state calls the hook makes. The default talks to the server
 * functions; tests pass an in-memory store.
 */
export interface ViewerStateStore {
  getViewerState(options: { data: ViewerStateSubject }): Promise<ViewerStateSnapshot | null>;
  saveViewerState(options: { data: ViewerStateWrite }): Promise<ViewerStateSnapshot | null>;
}

export const serverViewerStateStore: ViewerStateStore = { getViewerState, saveViewerState };

interface InitialViewerState {
  loaded: boolean;
  snapshot: ViewerStateSnapshot | null;
  subjectId: string | undefined;
}

/**
 * Loads the saved state for `subjectId` once and saves progress back. The
 * resume target is only ever the state loaded on open: saves made while the
 * item is on screen never feed back into it, or a first view would jump to
 * its own progress.
 */
export function useLibraryViewerState(
  subjectId: string | undefined,
  store: ViewerStateStore = serverViewerStateStore,
) {
  const [initial, setInitial] = useState<InitialViewerState>({
    loaded: false,
    snapshot: null,
    subjectId,
  });

  const pendingPatchRef = useRef<ViewerStatePatch | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Saves run one after another: the server upserts, so a slow older save that
  // landed last would overwrite newer progress.
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const subjectIdRef = useRef(subjectId);
  // The subject whose saved state has loaded. Until then a report (a PDF's page 1
  // before it scrolls to the saved page) would overwrite the state about to be resumed.
  const loadedSubjectIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    subjectIdRef.current = subjectId;
  }, [subjectId]);

  const clearSaveTimer = useCallback((): void => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  const flushSave = useCallback(
    async (targetSubjectId = subjectIdRef.current): Promise<void> => {
      const pending = pendingPatchRef.current;

      if (!targetSubjectId || !pending) {
        return;
      }

      pendingPatchRef.current = null;
      clearSaveTimer();

      const save = saveQueueRef.current.then(async () => {
        await store.saveViewerState({
          data: {
            subjectId: targetSubjectId,
            subjectType: "library_entry",
            ...pending,
          },
        });
      });

      // A failed save must not block the ones queued behind it.
      saveQueueRef.current = save.catch(() => undefined);

      await save;
    },
    [clearSaveTimer, store],
  );

  // A throttle, not a debounce: playback reports several times a second, and
  // a timer restarted on each report would never fire while the video plays.
  const scheduleSave = useCallback(
    (patch: ViewerStatePatch): void => {
      if (!subjectIdRef.current || loadedSubjectIdRef.current !== subjectIdRef.current) {
        return;
      }

      pendingPatchRef.current = {
        ...pendingPatchRef.current,
        ...patch,
      };

      if (saveTimerRef.current) {
        return;
      }

      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        void flushSave();
      }, VIEWER_STATE_SAVE_INTERVAL_MS);
    },
    [flushSave],
  );

  useEffect(() => {
    if (!subjectId) {
      return;
    }

    let cancelled = false;

    void (async () => {
      const snapshot = await store
        .getViewerState({
          data: {
            subjectId,
            subjectType: "library_entry",
          },
        })
        .catch(() => null);

      if (!cancelled) {
        loadedSubjectIdRef.current = subjectId;
        setInitial({ loaded: true, snapshot, subjectId });
      }
    })();

    return () => {
      cancelled = true;
      void flushSave(subjectId);
    };
  }, [store, subjectId, flushSave]);

  // Closing or backgrounding the tab may be the last chance to save.
  useEffect(() => {
    const flush = () => void flushSave();

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush();
    };

    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [flushSave]);

  useEffect(() => {
    return () => {
      clearSaveTimer();
    };
  }, [clearSaveTimer]);

  // Keyed by subject, so a change of subject reads as not loaded until its own load lands.
  const current = initial.subjectId === subjectId ? initial : null;

  return {
    flushSave,
    /** The state saved before this view; null when there is none (or not loaded yet). */
    initialSnapshot: current?.snapshot ?? null,
    /** True once the initial state has loaded; immediately when nothing is remembered. */
    loaded: !subjectId || (current?.loaded ?? false),
    scheduleSave,
  };
}
