// @vitest-environment jsdom

import type { MediaItem } from "@latch-works/media-domain";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaViewerModal } from "./MediaViewerModal";
import { VIEWER_STATE_SAVE_DEBOUNCE_MS } from "@/features/viewer/viewer-resume";

const videoItem: MediaItem = {
  durationMs: 120_000,
  extension: "mp4",
  id: "00000000-0000-4000-8000-000000000010",
  mediaType: "video",
  mtimeMs: 1_700_000_000_000,
  name: "clip.mp4",
  parentPath: "videos",
  path: "videos/clip.mp4",
  size: 12_345,
};

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

vi.mock("./useResolvedMediaUrl", () => ({
  useResolvedMediaUrl: () => ({
    failed: false,
    loading: false,
    resolvedUrl: "https://example.test/video.mp4",
  }),
}));

const flushSave = vi.fn();
const scheduleSave = vi.fn();

vi.mock("@/features/viewer/use-library-viewer-state", () => ({
  useLibraryViewerState: (subjectId: string | undefined) => ({
    flushSave: subjectId ? flushSave : vi.fn(),
    scheduleSave: subjectId ? scheduleSave : vi.fn(),
    snapshot: subjectId
      ? {
          positionMs: 45_000,
          subjectId: videoItem.id,
          subjectType: "library_entry" as const,
          updatedAt: "2026-06-12T00:00:00.000Z",
        }
      : null,
  }),
}));

function renderModal(rememberViewerPosition = true): { root: Root; container: HTMLDivElement } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      createElement(MediaViewerModal, {
        autoplayVideos: false,
        items: [videoItem],
        loopNavigation: false,
        loopVideos: false,
        onClose: vi.fn(),
        rememberViewerPosition,
        startIndex: 0,
      }),
    );
  });

  return { container, root };
}

describe("MediaViewerModal resume state", () => {
  let root: Root | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    flushSave.mockReset();
    scheduleSave.mockReset();
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("seeks the video after metadata loads", () => {
    ({ root } = renderModal());
    const video = document.querySelector("video");
    expect(video).not.toBeNull();

    act(() => {
      Object.defineProperty(video, "duration", {
        configurable: true,
        value: 120,
      });
      video?.dispatchEvent(new Event("loadedmetadata"));
    });

    expect(video?.currentTime).toBe(45);
  });

  it("debounces save calls from time updates", () => {
    ({ root } = renderModal());
    const video = document.querySelector("video");
    expect(video).not.toBeNull();

    act(() => {
      Object.defineProperty(video, "currentTime", {
        configurable: true,
        value: 12.5,
        writable: true,
      });
      video?.dispatchEvent(new Event("timeupdate"));
      video?.dispatchEvent(new Event("timeupdate"));
    });

    expect(scheduleSave).toHaveBeenCalledTimes(2);
    expect(scheduleSave).toHaveBeenCalledWith({ positionMs: 12_500 });
    expect(flushSave).not.toHaveBeenCalled();
  });

  it("flushes saved position on pause", () => {
    ({ root } = renderModal());
    const video = document.querySelector("video");
    expect(video).not.toBeNull();

    act(() => {
      Object.defineProperty(video, "currentTime", {
        configurable: true,
        value: 30,
        writable: true,
      });
      video?.dispatchEvent(new Event("pause"));
    });

    expect(scheduleSave).toHaveBeenCalledWith({ positionMs: 30_000 });
    expect(flushSave).toHaveBeenCalledTimes(1);
  });

  it("flushes saved position when the modal unmounts", () => {
    ({ root } = renderModal());

    act(() => {
      root?.unmount();
    });

    expect(flushSave).toHaveBeenCalledTimes(1);
  });

  it("does not schedule saves faster than the debounce window during playback", () => {
    ({ root } = renderModal());
    const video = document.querySelector("video");
    expect(video).not.toBeNull();

    act(() => {
      Object.defineProperty(video, "currentTime", {
        configurable: true,
        value: 5,
        writable: true,
      });
      video?.dispatchEvent(new Event("timeupdate"));
    });

    act(() => {
      vi.advanceTimersByTime(VIEWER_STATE_SAVE_DEBOUNCE_MS - 1);
      Object.defineProperty(video, "currentTime", {
        configurable: true,
        value: 6,
        writable: true,
      });
      video?.dispatchEvent(new Event("timeupdate"));
    });

    expect(scheduleSave).toHaveBeenCalledTimes(2);
    expect(flushSave).not.toHaveBeenCalled();
  });

  it("does not resume or save position when rememberViewerPosition is disabled", () => {
    ({ root } = renderModal(false));
    const video = document.querySelector("video");
    expect(video).not.toBeNull();

    act(() => {
      Object.defineProperty(video, "duration", {
        configurable: true,
        value: 120,
      });
      video?.dispatchEvent(new Event("loadedmetadata"));
    });

    expect(video?.currentTime).toBe(0);

    act(() => {
      Object.defineProperty(video, "currentTime", {
        configurable: true,
        value: 12.5,
        writable: true,
      });
      video?.dispatchEvent(new Event("timeupdate"));
      video?.dispatchEvent(new Event("pause"));
    });

    expect(scheduleSave).not.toHaveBeenCalled();
    expect(flushSave).not.toHaveBeenCalled();
  });
});
