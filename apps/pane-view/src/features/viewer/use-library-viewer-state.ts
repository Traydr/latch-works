import { useCallback, useEffect, useRef, useState } from "react";
import { VIEWER_STATE_SAVE_DEBOUNCE_MS } from "./viewer-resume";
import { getViewerState, saveViewerState, type ViewerStateSnapshot } from "./viewer-state-service";

interface ViewerStatePatch {
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

export function useLibraryViewerState(
  subjectId: string | undefined,
  store: ViewerStateStore = serverViewerStateStore,
) {
  const [snapshot, setSnapshot] = useState<ViewerStateSnapshot | null>(null);
  const pendingPatchRef = useRef<ViewerStatePatch | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subjectIdRef = useRef(subjectId);

  useEffect(() => {
    subjectIdRef.current = subjectId;
  }, [subjectId]);

  const clearDebounceTimer = useCallback((): void => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  const flushSave = useCallback(
    async (targetSubjectId = subjectIdRef.current): Promise<void> => {
      const pending = pendingPatchRef.current;
      if (!targetSubjectId || !pending) {
        return;
      }

      pendingPatchRef.current = null;
      clearDebounceTimer();

      const saved = await store.saveViewerState({
        data: {
          subjectId: targetSubjectId,
          subjectType: "library_entry",
          ...pending,
        },
      });

      if (saved && targetSubjectId === subjectIdRef.current) {
        setSnapshot(saved);
      }
    },
    [clearDebounceTimer, store],
  );

  const scheduleSave = useCallback(
    (patch: ViewerStatePatch): void => {
      if (!subjectIdRef.current) {
        return;
      }

      pendingPatchRef.current = {
        ...pendingPatchRef.current,
        ...patch,
      };

      clearDebounceTimer();
      debounceTimerRef.current = setTimeout(() => {
        void flushSave();
      }, VIEWER_STATE_SAVE_DEBOUNCE_MS);
    },
    [clearDebounceTimer, flushSave],
  );

  useEffect(() => {
    if (!subjectId) {
      setSnapshot(null);
      return;
    }

    let cancelled = false;
    setSnapshot(null);

    void (async () => {
      const state = await store.getViewerState({
        data: {
          subjectId,
          subjectType: "library_entry",
        },
      });

      if (!cancelled) {
        setSnapshot(state);
      }
    })();

    return () => {
      cancelled = true;
      void flushSave(subjectId);
    };
  }, [store, subjectId, flushSave]);

  useEffect(() => {
    return () => {
      clearDebounceTimer();
    };
  }, [clearDebounceTimer]);

  return {
    flushSave,
    scheduleSave,
    snapshot,
  };
}
