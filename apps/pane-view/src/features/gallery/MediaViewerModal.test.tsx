// @vitest-environment jsdom

import type { MediaItem } from "@latch-works/media-domain";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ViewerStateStore,
  ViewerStateWrite,
} from "@/features/viewer/use-library-viewer-state";
import { VIEWER_STATE_SAVE_DEBOUNCE_MS } from "@/features/viewer/viewer-resume";
import { MediaViewerModal } from "./MediaViewerModal";
import { createResolvedMediaUrlCache, type ResolvedMediaUrlCache } from "./useResolvedMediaUrl";

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

/** jsdom has no matchMedia; the viewer chrome only asks whether this is a phone. */
function stubMatchMedia(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      addEventListener: vi.fn(),
      matches: false,
      removeEventListener: vi.fn(),
    })),
  });
}

function fakeUrlCache(url: string): ResolvedMediaUrlCache {
  return createResolvedMediaUrlCache({ resolve: async () => ({ pending: false, url }) });
}

/** In-memory stand-in for the viewer-state server functions. */
function fakeViewerStateStore(saved: ViewerStateWrite[]) {
  return {
    getViewerState: vi.fn<ViewerStateStore["getViewerState"]>(async () => ({
      positionMs: 45_000,
      subjectId: videoItem.id,
      subjectType: "library_entry",
      updatedAt: "2026-06-12T00:00:00.000Z",
    })),
    saveViewerState: vi.fn<ViewerStateStore["saveViewerState"]>(async ({ data }) => {
      saved.push(data);
      return null;
    }),
  } satisfies ViewerStateStore;
}

interface MountedModal {
  root: Root;
  container: HTMLDivElement;
}

let saved: ViewerStateWrite[];
let viewerStateStore: ReturnType<typeof fakeViewerStateStore>;

async function renderModal(rememberViewerPosition = true): Promise<MountedModal> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      createElement(MediaViewerModal, {
        autoplayVideos: false,
        cache: fakeUrlCache("https://example.test/video.mp4"),
        hasMore: false,
        items: [videoItem],
        loopNavigation: false,
        loopVideos: false,
        mediaId: videoItem.id,
        onClose: vi.fn(),
        onSelect: vi.fn(),
        rememberViewerPosition,
        stepMedia: async () => null,
        viewerStateStore,
      }),
    );
  });

  // Let the stored position load before the video reports its metadata.
  await act(async () => {
    await Promise.resolve();
  });

  return { container, root };
}

describe("MediaViewerModal resume state", () => {
  let root: Root | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    stubMatchMedia();
    saved = [];
    viewerStateStore = fakeViewerStateStore(saved);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("seeks the video after metadata loads", async () => {
    ({ root } = await renderModal());
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

  it("debounces save calls from time updates", async () => {
    ({ root } = await renderModal());
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

    expect(viewerStateStore.saveViewerState).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(VIEWER_STATE_SAVE_DEBOUNCE_MS);
      await Promise.resolve();
    });

    expect(viewerStateStore.saveViewerState).toHaveBeenCalledTimes(1);
    expect(saved).toEqual([
      { positionMs: 12_500, subjectId: videoItem.id, subjectType: "library_entry" },
    ]);
  });

  it("flushes saved position on pause", async () => {
    ({ root } = await renderModal());
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

    // Pause flushes immediately instead of waiting out the debounce window.
    expect(saved).toEqual([
      { positionMs: 30_000, subjectId: videoItem.id, subjectType: "library_entry" },
    ]);
  });

  it("flushes saved position when the modal unmounts", async () => {
    ({ root } = await renderModal());
    const video = document.querySelector("video");

    act(() => {
      Object.defineProperty(video, "currentTime", {
        configurable: true,
        value: 20,
        writable: true,
      });
      video?.dispatchEvent(new Event("timeupdate"));
    });
    expect(viewerStateStore.saveViewerState).not.toHaveBeenCalled();

    act(() => {
      root?.unmount();
    });

    expect(viewerStateStore.saveViewerState).toHaveBeenCalledTimes(1);
    expect(saved).toEqual([
      { positionMs: 20_000, subjectId: videoItem.id, subjectType: "library_entry" },
    ]);
  });

  it("does not schedule saves faster than the debounce window during playback", async () => {
    ({ root } = await renderModal());
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

    // The second update restarts the window instead of writing its own save.
    expect(viewerStateStore.saveViewerState).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(VIEWER_STATE_SAVE_DEBOUNCE_MS);
      await Promise.resolve();
    });

    expect(viewerStateStore.saveViewerState).toHaveBeenCalledTimes(1);
    expect(saved).toEqual([
      { positionMs: 6_000, subjectId: videoItem.id, subjectType: "library_entry" },
    ]);
  });

  it("does not resume or save position when rememberViewerPosition is disabled", async () => {
    ({ root } = await renderModal(false));
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

    expect(viewerStateStore.getViewerState).not.toHaveBeenCalled();
    expect(viewerStateStore.saveViewerState).not.toHaveBeenCalled();
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
  const cache = fakeUrlCache("https://example.test/photo.jpg");
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
          cache,
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
    stubMatchMedia();
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
