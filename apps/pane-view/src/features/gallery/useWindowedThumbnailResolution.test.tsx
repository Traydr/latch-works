// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GalleryThumbnailResolver } from "./batched-thumbnail-resolver";
import type { GalleryBrowseEntry } from "./gallery-browse-entry";
import { mediaItem } from "./gallery-session-harness";
import {
  FIRST_BATCH_DELAY_MS,
  useWindowedThumbnailResolution,
  WINDOW_CHANGE_DEBOUNCE_MS,
} from "./useWindowedThumbnailResolution";

/** Stands in for the shared batching resolver; the hook only drives these four calls. */
const mocks = {
  getNextPendingThumbnailRetryMs:
    vi.fn<GalleryThumbnailResolver["getNextPendingThumbnailRetryMs"]>(),
  hasEligibleGalleryThumbnailRequests:
    vi.fn<GalleryThumbnailResolver["hasEligibleGalleryThumbnailRequests"]>(),
  resolveGalleryThumbnailsBatch: vi.fn<GalleryThumbnailResolver["resolveGalleryThumbnailsBatch"]>(),
};

const resolver: GalleryThumbnailResolver = {
  getNextPendingThumbnailRetryMs: mocks.getNextPendingThumbnailRetryMs,
  hasEligibleGalleryThumbnailRequests: mocks.hasEligibleGalleryThumbnailRequests,
  readCachedGalleryThumbnailState: () => ({ urls: {} }),
  resolveGalleryThumbnailsBatch: mocks.resolveGalleryThumbnailsBatch,
};

interface WindowedThumbnailHarness {
  setEntries: (mediaIds: string[]) => void;
  rerender: (nextResetKey: string) => void;
  unmount: () => void;
}

function renderHook(resetKey: string): WindowedThumbnailHarness {
  let currentResetKey = resetKey;
  let currentEntries: GalleryBrowseEntry[] = [];
  let root: Root | undefined;
  const container = document.createElement("div");

  function Host(): ReactNode {
    useWindowedThumbnailResolution(currentResetKey, currentEntries, resolver);
    return null;
  }

  act(() => {
    root = createRoot(container);
    root.render(createElement(Host));
  });

  return {
    setEntries: (mediaIds) => {
      currentEntries = mediaIds.map((id) => ({
        key: `media:${id}`,
        kind: "media",
        media: mediaItem(id),
      }));
      act(() => {
        root?.render(createElement(Host));
      });
    },
    rerender: (nextResetKey) => {
      currentResetKey = nextResetKey;
      act(() => root?.render(createElement(Host)));
    },
    unmount: () => act(() => root?.unmount()),
  };
}

describe("useWindowedThumbnailResolution", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.getNextPendingThumbnailRetryMs.mockReset();
    // The real resolver returns `number | null`; without a default the mock
    // yields undefined and the hook schedules a retry that never settles.
    mocks.getNextPendingThumbnailRetryMs.mockReturnValue(null);
    mocks.hasEligibleGalleryThumbnailRequests.mockReset();
    mocks.resolveGalleryThumbnailsBatch.mockReset();
    mocks.resolveGalleryThumbnailsBatch.mockResolvedValue({ urls: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels a scheduled drain when the visible window is replaced", async () => {
    mocks.hasEligibleGalleryThumbnailRequests.mockReturnValueOnce(true).mockReturnValue(false);
    const hook = renderHook("library-a");
    hook.setEntries(["old"]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FIRST_BATCH_DELAY_MS);
    });
    expect(mocks.resolveGalleryThumbnailsBatch).toHaveBeenCalledWith([{ mediaId: "old" }]);

    // Same browse, so replacing the window takes the scrolling debounce.
    hook.setEntries(["new"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WINDOW_CHANGE_DEBOUNCE_MS);
    });

    expect(mocks.resolveGalleryThumbnailsBatch).toHaveBeenCalledWith([{ mediaId: "new" }]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.resolveGalleryThumbnailsBatch).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it("cancels a scheduled drain when the reset key changes", async () => {
    mocks.hasEligibleGalleryThumbnailRequests.mockReturnValue(true);
    const hook = renderHook("library-a");
    hook.setEntries(["old"]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FIRST_BATCH_DELAY_MS);
    });
    hook.rerender("library-b");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.resolveGalleryThumbnailsBatch).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it("waits for a pending retry instead of scheduling another drain", async () => {
    mocks.hasEligibleGalleryThumbnailRequests.mockReturnValue(false);
    mocks.getNextPendingThumbnailRetryMs.mockReturnValueOnce(5_000).mockReturnValue(null);
    const hook = renderHook("library-a");
    hook.setEntries(["pending"]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FIRST_BATCH_DELAY_MS);
    });
    expect(mocks.resolveGalleryThumbnailsBatch).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(mocks.resolveGalleryThumbnailsBatch).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.resolveGalleryThumbnailsBatch).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it("gives a new browse the short delay and a same-browse window change the full debounce", async () => {
    mocks.hasEligibleGalleryThumbnailRequests.mockReturnValue(false);
    const hook = renderHook("library-a");
    hook.setEntries(["a"]);

    // First batch of a browse: nothing to coalesce, so only the short delay.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FIRST_BATCH_DELAY_MS);
    });
    expect(mocks.resolveGalleryThumbnailsBatch).toHaveBeenCalledTimes(1);

    // Same browse: a window change is scrolling, and still waits the debounce.
    hook.setEntries(["b"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FIRST_BATCH_DELAY_MS);
    });
    expect(mocks.resolveGalleryThumbnailsBatch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WINDOW_CHANGE_DEBOUNCE_MS - FIRST_BATCH_DELAY_MS);
    });
    expect(mocks.resolveGalleryThumbnailsBatch).toHaveBeenCalledTimes(2);

    // A new browse is back to the short delay.
    hook.rerender("library-b");
    hook.setEntries(["c"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FIRST_BATCH_DELAY_MS);
    });
    expect(mocks.resolveGalleryThumbnailsBatch).toHaveBeenCalledTimes(3);
    hook.unmount();
  });
});
