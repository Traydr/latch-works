// @vitest-environment jsdom

import { act, createElement, type MutableRefObject, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLibraryViewerState, type ViewerStateStore } from "./use-library-viewer-state";
import { VIEWER_STATE_SAVE_DEBOUNCE_MS } from "./viewer-resume";

/** Stands in for the viewer-state server functions. */
const getViewerState = vi.fn<ViewerStateStore["getViewerState"]>();
const saveViewerState = vi.fn<ViewerStateStore["saveViewerState"]>();
const store: ViewerStateStore = { getViewerState, saveViewerState };

type HookApi = ReturnType<typeof useLibraryViewerState>;

interface HookHarness {
  getApi: () => HookApi;
  rerender: (nextSubjectId: string | undefined) => void;
  unmount: () => void;
}

function renderHook(subjectId: string | undefined): HookHarness {
  const latestApi: MutableRefObject<HookApi | null> = { current: null };
  let currentSubjectId = subjectId;
  let root: Root | undefined;
  const container = document.createElement("div");

  function Host(): ReactNode {
    latestApi.current = useLibraryViewerState(currentSubjectId, store);
    return null;
  }

  act(() => {
    root = createRoot(container);
    root.render(createElement(Host));
  });

  if (!latestApi.current) {
    throw new Error("Hook did not render");
  }

  return {
    getApi: () => {
      if (!latestApi.current) {
        throw new Error("Hook is not mounted");
      }
      return latestApi.current;
    },
    rerender: (nextSubjectId) => {
      currentSubjectId = nextSubjectId;
      act(() => {
        root?.render(createElement(Host));
      });
    },
    unmount: () => {
      act(() => {
        root?.unmount();
      });
    },
  };
}

describe("useLibraryViewerState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getViewerState.mockReset();
    saveViewerState.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads viewer state for the selected library entry", async () => {
    getViewerState.mockResolvedValue({
      positionMs: 12_000,
      subjectId: "00000000-0000-4000-8000-000000000001",
      subjectType: "library_entry",
      updatedAt: "2026-06-12T00:00:00.000Z",
    });

    const { getApi } = renderHook("00000000-0000-4000-8000-000000000001");

    await vi.waitFor(() => {
      expect(getApi().snapshot?.positionMs).toBe(12_000);
    });

    expect(getViewerState).toHaveBeenCalledWith({
      data: {
        subjectId: "00000000-0000-4000-8000-000000000001",
        subjectType: "library_entry",
      },
    });
  });

  it("debounces saveViewerState calls", async () => {
    getViewerState.mockResolvedValue(null);
    saveViewerState.mockResolvedValue(null);

    const { getApi } = renderHook("00000000-0000-4000-8000-000000000002");

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      getApi().scheduleSave({ positionMs: 1_000 });
      getApi().scheduleSave({ positionMs: 2_000 });
      getApi().scheduleSave({ positionMs: 3_000 });
    });

    expect(saveViewerState).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(VIEWER_STATE_SAVE_DEBOUNCE_MS);
      await Promise.resolve();
    });

    expect(saveViewerState).toHaveBeenCalledTimes(1);
    expect(saveViewerState).toHaveBeenCalledWith({
      data: {
        positionMs: 3_000,
        subjectId: "00000000-0000-4000-8000-000000000002",
        subjectType: "library_entry",
      },
    });
  });

  it("flushes pending state when the subject changes", async () => {
    getViewerState.mockResolvedValue(null);
    saveViewerState.mockResolvedValue(null);

    const { getApi, rerender } = renderHook("00000000-0000-4000-8000-000000000003");

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      getApi().scheduleSave({ positionMs: 9_000 });
    });

    rerender("00000000-0000-4000-8000-000000000004");

    await act(async () => {
      await Promise.resolve();
    });

    expect(saveViewerState).toHaveBeenCalledWith({
      data: {
        positionMs: 9_000,
        subjectId: "00000000-0000-4000-8000-000000000003",
        subjectType: "library_entry",
      },
    });
  });

  it("flushes pending state on unmount", async () => {
    getViewerState.mockResolvedValue(null);
    saveViewerState.mockResolvedValue(null);

    const { getApi, unmount } = renderHook("00000000-0000-4000-8000-000000000005");

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      getApi().scheduleSave({ page: 4 });
    });

    unmount();

    await act(async () => {
      await Promise.resolve();
    });

    expect(saveViewerState).toHaveBeenCalledWith({
      data: {
        page: 4,
        subjectId: "00000000-0000-4000-8000-000000000005",
        subjectType: "library_entry",
      },
    });
  });
});
