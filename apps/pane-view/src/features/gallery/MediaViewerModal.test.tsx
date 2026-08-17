// @vitest-environment jsdom

import type { MediaItem } from "@latch-works/media-domain";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VIEWER_STATE_SAVE_DEBOUNCE_MS } from "@/features/viewer/viewer-resume";
import { MediaViewerModal } from "./MediaViewerModal";

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

interface MountedModal {
  root: Root;
  container: HTMLDivElement;
}

function renderModal(rememberViewerPosition = true): MountedModal {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      createElement(MediaViewerModal, {
        autoplayVideos: false,
        hasMore: false,
        items: [videoItem],
        loopNavigation: false,
        loopVideos: false,
        mediaId: videoItem.id,
        onClose: vi.fn(),
        onSelect: vi.fn(),
        rememberViewerPosition,
        stepMedia: async () => null,
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

// ---------------------------------------------------------------------------
// Controlled viewer (Plan 052 Step 4)
// ---------------------------------------------------------------------------

function imageItem(id: string): MediaItem {
  return {
    extension: "jpg",
    id,
    mediaType: "image",
    mtimeMs: 1_700_000_000_000,
    name: `${id}.jpg`,
    parentPath: "photos",
    path: `photos/${id}.jpg`,
    size: 100,
  };
}

interface ControlledProps {
  hasMore: boolean;
  items: MediaItem[];
  loopNavigation: boolean;
  mediaId: string;
}

function renderControlled(initial: ControlledProps) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onClose = vi.fn();
  const onSelect = vi.fn();
  const stepMedia =
    vi.fn<(id: string, direction: -1 | 1, loop: boolean) => Promise<string | null>>();
  let props = initial;

  const render = () =>
    act(() => {
      root.render(
        createElement(MediaViewerModal, {
          autoplayVideos: false,
          hasMore: props.hasMore,
          items: props.items,
          loopNavigation: props.loopNavigation,
          loopVideos: false,
          mediaId: props.mediaId,
          onClose,
          onSelect,
          rememberViewerPosition: false,
          stepMedia,
        }),
      );
    });
  render();

  return {
    container,
    onClose,
    onSelect,
    press(key: string) {
      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
      });
    },
    rerender(next: Partial<ControlledProps>) {
      props = { ...props, ...next };
      render();
    },
    root,
    stepMedia,
    async settle() {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    },
  };
}

function shownName(container: HTMLElement): string | undefined {
  return container.querySelector("dialog")?.getAttribute("aria-label")?.replace("Viewer for ", "");
}

describe("MediaViewerModal controlled by media id", () => {
  let view: ReturnType<typeof renderControlled> | undefined;

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    act(() => {
      view?.root.unmount();
    });
    view = undefined;
    document.body.innerHTML = "";
  });

  it("forward at a partial-page boundary asks the session to step and selects the answer", async () => {
    const items = [imageItem("a"), imageItem("b")];
    view = renderControlled({ hasMore: true, items, loopNavigation: false, mediaId: "b" });
    view.stepMedia.mockResolvedValueOnce("c");

    view.press("ArrowRight");
    await view.settle();

    expect(view.stepMedia).toHaveBeenCalledWith("b", 1, false);
    expect(view.onSelect).toHaveBeenCalledWith("c");
    // The appended page reaches the open viewer; the selection then shows it.
    view.rerender({ hasMore: false, items: [...items, imageItem("c")], mediaId: "c" });
    expect(shownName(view.container)).toBe("c.jpg");
  });

  it("at the true end wraps only when loop navigation is on", async () => {
    const items = [imageItem("a"), imageItem("b")];
    view = renderControlled({ hasMore: false, items, loopNavigation: false, mediaId: "b" });
    view.stepMedia.mockResolvedValueOnce(null);
    view.press("ArrowRight");
    await view.settle();
    expect(view.stepMedia).toHaveBeenCalledWith("b", 1, false);
    expect(view.onSelect).not.toHaveBeenCalled();
    expect(shownName(view.container)).toBe("b.jpg");

    view.rerender({ loopNavigation: true });
    view.stepMedia.mockResolvedValueOnce("a");
    view.press("ArrowRight");
    await view.settle();
    expect(view.stepMedia).toHaveBeenLastCalledWith("b", 1, true);
    expect(view.onSelect).toHaveBeenCalledWith("a");
  });

  it("keeps the current media when other items are inserted or removed", () => {
    view = renderControlled({
      hasMore: false,
      items: [imageItem("a"), imageItem("b"), imageItem("c")],
      loopNavigation: false,
      mediaId: "b",
    });
    expect(shownName(view.container)).toBe("b.jpg");
    view.rerender({ items: [imageItem("x"), imageItem("a"), imageItem("b"), imageItem("c")] });
    expect(shownName(view.container)).toBe("b.jpg");
    view.rerender({ items: [imageItem("b"), imageItem("c")] });
    expect(shownName(view.container)).toBe("b.jpg");
    // Even if the current item leaves the sequence, the dialog does not blank.
    view.rerender({ items: [imageItem("c")] });
    expect(shownName(view.container)).toBe("b.jpg");
  });

  it("stays on the current media when the load fails and permits a retry", async () => {
    view = renderControlled({
      hasMore: true,
      items: [imageItem("a")],
      loopNavigation: true,
      mediaId: "a",
    });
    view.stepMedia.mockResolvedValueOnce(null);
    view.press("ArrowRight");
    await view.settle();
    expect(view.onSelect).not.toHaveBeenCalled();
    expect(shownName(view.container)).toBe("a.jpg");

    view.stepMedia.mockResolvedValueOnce("b");
    view.press("ArrowRight");
    await view.settle();
    expect(view.stepMedia).toHaveBeenCalledTimes(2);
    expect(view.onSelect).toHaveBeenCalledWith("b");
  });

  it("ignores repeated forward presses during a load but still closes on Escape", async () => {
    view = renderControlled({
      hasMore: true,
      items: [imageItem("a")],
      loopNavigation: false,
      mediaId: "a",
    });
    let resolveStep: ((id: string | null) => void) | undefined;
    view.stepMedia.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          resolveStep = resolve;
        }),
    );
    view.press("ArrowRight");
    view.press("ArrowRight");
    view.press("ArrowRight");
    expect(view.stepMedia).toHaveBeenCalledTimes(1);

    view.press("Escape");
    expect(view.onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveStep?.("b");
      await Promise.resolve();
    });
    expect(view.onSelect).toHaveBeenCalledWith("b");
  });

  it("disables backward on the first item while more pages exist and forward only at the true end without loop", () => {
    view = renderControlled({
      hasMore: true,
      items: [imageItem("a"), imageItem("b")],
      loopNavigation: true,
      mediaId: "a",
    });
    const buttons = () => Array.from(view?.container.querySelectorAll("button") ?? []);
    const disabledLabels = () =>
      buttons()
        .filter((button) => button.disabled)
        .map((button) => button.getAttribute("aria-label"));
    expect(disabledLabels()).toContain("Previous item");
    expect(disabledLabels()).not.toContain("Next item");

    view.rerender({ hasMore: false, loopNavigation: false, mediaId: "b" });
    expect(disabledLabels()).toContain("Next item");
    expect(disabledLabels()).not.toContain("Previous item");
  });
});
