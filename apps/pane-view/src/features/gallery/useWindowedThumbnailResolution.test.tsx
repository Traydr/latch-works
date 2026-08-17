// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GalleryBrowseEntry } from "./gallery-browse-entry";
import { mediaItem } from "./gallery-session-harness";
import { useWindowedThumbnailResolution } from "./useWindowedThumbnailResolution";

const mocks = vi.hoisted(() => ({
  getNextPendingThumbnailRetryMs: vi.fn(),
  hasEligibleGalleryThumbnailRequests: vi.fn(),
  resolveGalleryThumbnailsBatch: vi.fn(),
}));

vi.mock("./batched-thumbnail-resolver", () => ({
  getNextPendingThumbnailRetryMs: mocks.getNextPendingThumbnailRetryMs,
  hasEligibleGalleryThumbnailRequests: mocks.hasEligibleGalleryThumbnailRequests,
  readCachedGalleryThumbnailState: vi.fn(() => ({ urls: {} })),
  resolveGalleryThumbnailsBatch: mocks.resolveGalleryThumbnailsBatch,
}));

vi.mock("./gallery-page-helpers", () => ({
  dedupeThumbnailRequests: vi.fn((requests) => requests),
  supportsGalleryThumbnail: vi.fn(() => true),
}));

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
    useWindowedThumbnailResolution(currentResetKey, currentEntries);
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
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(mocks.resolveGalleryThumbnailsBatch).toHaveBeenCalledWith([{ mediaId: "old" }]);

    hook.setEntries(["new"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
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
      await vi.advanceTimersByTimeAsync(200);
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
      await vi.advanceTimersByTimeAsync(200);
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
});
