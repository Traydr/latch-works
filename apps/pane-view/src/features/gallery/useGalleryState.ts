import type { GallerySortMode } from "@latch-works/media-domain";
import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "pane-view.state";

interface PersistedState {
  comicMode: boolean;
  detailPanelOpen: boolean;
  lastPath: string;
  lastSelectedId: string | null;
  recursive: boolean;
  sortMode: GallerySortMode;
}

const DEFAULT_STATE: PersistedState = {
  comicMode: false,
  detailPanelOpen: true,
  lastPath: "",
  lastSelectedId: null,
  recursive: false,
  sortMode: "name-asc",
};

function readPersistedState(): PersistedState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_STATE;
    }

    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return DEFAULT_STATE;
    }

    const record = parsed as Record<string, unknown>;
    return {
      comicMode: typeof record.comicMode === "boolean" ? record.comicMode : DEFAULT_STATE.comicMode,
      detailPanelOpen:
        typeof record.detailPanelOpen === "boolean"
          ? record.detailPanelOpen
          : DEFAULT_STATE.detailPanelOpen,
      lastPath: typeof record.lastPath === "string" ? record.lastPath : DEFAULT_STATE.lastPath,
      lastSelectedId:
        typeof record.lastSelectedId === "string" || record.lastSelectedId === null
          ? record.lastSelectedId
          : DEFAULT_STATE.lastSelectedId,
      recursive: typeof record.recursive === "boolean" ? record.recursive : DEFAULT_STATE.recursive,
      sortMode: isSortMode(record.sortMode) ? record.sortMode : DEFAULT_STATE.sortMode,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function writePersistedState(state: PersistedState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage errors.
  }
}

function isSortMode(value: unknown): value is GallerySortMode {
  return (
    value === "name-asc" ||
    value === "name-desc" ||
    value === "date-newest" ||
    value === "date-oldest" ||
    value === "random"
  );
}

export function useGalleryState() {
  const [state, setState] = useState<PersistedState>(() => {
    if (typeof window === "undefined") {
      return DEFAULT_STATE;
    }

    return readPersistedState();
  });

  const updateState = useCallback((patch: Partial<PersistedState>) => {
    setState((current) => {
      const next = { ...current, ...patch };
      writePersistedState(next);
      return next;
    });
  }, []);

  const queueRef = useRef<Partial<PersistedState> | null>(null);

  useEffect(() => {
    if (queueRef.current) {
      updateState(queueRef.current);
      queueRef.current = null;
    }
  }, [updateState]);

  return {
    comicMode: state.comicMode,
    detailPanelOpen: state.detailPanelOpen,
    lastPath: state.lastPath,
    lastSelectedId: state.lastSelectedId,
    recursive: state.recursive,
    setComicMode: useCallback((comicMode: boolean) => updateState({ comicMode }), [updateState]),
    setDetailPanelOpen: useCallback(
      (detailPanelOpen: boolean) => updateState({ detailPanelOpen }),
      [updateState],
    ),
    setLastPath: useCallback((lastPath: string) => updateState({ lastPath }), [updateState]),
    setLastSelectedId: useCallback(
      (lastSelectedId: string | null) => updateState({ lastSelectedId }),
      [updateState],
    ),
    setRecursive: useCallback((recursive: boolean) => updateState({ recursive }), [updateState]),
    setSortMode: useCallback(
      (sortMode: GallerySortMode) => updateState({ sortMode }),
      [updateState],
    ),
    sortMode: state.sortMode,
  };
}
