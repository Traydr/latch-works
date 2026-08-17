// @vitest-environment jsdom

import { act, createElement, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GalleryBrowseEntry } from "./gallery-browse-entry";
import { useGalleryKeyboard } from "./useGalleryKeyboard";

/**
 * Grid keyboard wiring around the session: geometry stays in the hook, only a
 * move past the true sequence boundary reaches the session, and a key the
 * session resolves before its page renders is focused once the entries commit.
 */

function mediaEntry(id: string): GalleryBrowseEntry {
  return {
    key: `media:${id}`,
    kind: "media",
    media: {
      extension: "jpg",
      id,
      mediaType: "image",
      mtimeMs: 0,
      name: `${id}.jpg`,
      parentPath: "p",
      path: `p/${id}.jpg`,
      size: 1,
    },
  };
}

const entries = (count: number) => Array.from({ length: count }, (_, i) => mediaEntry(`m${i}`));

describe("useGalleryKeyboard grid movement", () => {
  let root: Root | undefined;
  let setEntries: ((next: GalleryBrowseEntry[]) => void) | undefined;
  let focused = 0;
  const onStepBeyondGrid =
    vi.fn<(key: string | null, direction: -1 | 1) => Promise<string | null>>();
  const onSelectMedia = vi.fn();
  const columnCountRef = { current: 4 };

  function mount(initial: GalleryBrowseEntry[], initialFocus = 0) {
    focused = initialFocus;
    function Host(): ReactNode {
      const [list, setList] = useState(initial);
      const [focusedEntryIndex, setFocusedEntryIndex] = useState(initialFocus);
      setEntries = setList;
      focused = focusedEntryIndex;
      useGalleryKeyboard({
        columnCountRef,
        displayPath: "p",
        entries: list,
        focusedEntryIndex,
        hotkeysOpen: false,
        mobileSearchOpen: false,
        onActivateEntry: vi.fn(),
        onCloseOverlays: vi.fn(),
        onNavigateSiblingFolder: vi.fn(),
        onNavigateToPath: vi.fn(),
        onOpenHotkeys: vi.fn(),
        onSelectMedia,
        onStepBeyondGrid,
        pathSheetOpen: false,
        requestScrollFocusedIntoView: vi.fn(),
        setFocusedEntryIndex,
        settingsOpen: false,
        viewerOpen: false,
      });
      return null;
    }
    const container = document.createElement("div");
    act(() => {
      root = createRoot(container);
      root.render(createElement(Host));
    });
  }

  const press = (key: string) =>
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key }));
    });

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    onStepBeyondGrid.mockReset();
    onSelectMedia.mockReset();
  });

  afterEach(() => {
    act(() => root?.unmount());
    vi.unstubAllGlobals();
  });

  it("moves spatially inside the loaded grid without asking the session", () => {
    mount(entries(10), 0);
    press("ArrowRight");
    expect(focused).toBe(1);
    press("ArrowDown");
    expect(focused).toBe(5);
    press("ArrowLeft");
    expect(focused).toBe(4);
    press("ArrowUp");
    expect(focused).toBe(0);
    expect(onStepBeyondGrid).not.toHaveBeenCalled();
    expect(onSelectMedia).toHaveBeenLastCalledWith("m0");
  });

  it("stays put on Up from the top row unless it is the very first entry", () => {
    mount(entries(10), 1);
    press("ArrowUp");
    expect(focused).toBe(1);
    expect(onStepBeyondGrid).not.toHaveBeenCalled();
  });

  it("clamps Down from the second-to-last row into a shorter last row", () => {
    // 10 entries in 4 columns: rows of 4, 4, 2. From index 7 (row 1, col 3), Down
    // targets index 11, which does not exist; the last entry (9) is focused instead.
    mount(entries(10), 7);
    press("ArrowDown");
    expect(focused).toBe(9);
    expect(onStepBeyondGrid).not.toHaveBeenCalled();
  });

  it("delegates Left/Up from the first entry and Right/Down from the last row to the session", async () => {
    onStepBeyondGrid.mockResolvedValue(null);
    mount(entries(10), 0);
    press("ArrowLeft");
    expect(onStepBeyondGrid).toHaveBeenLastCalledWith("media:m0", -1);
    press("ArrowUp");
    expect(onStepBeyondGrid).toHaveBeenLastCalledWith("media:m0", -1);
    act(() => root?.unmount());

    mount(entries(10), 8);
    press("ArrowDown");
    expect(onStepBeyondGrid).toHaveBeenLastCalledWith("media:m8", 1);
    act(() => root?.unmount());

    mount(entries(10), 9);
    press("ArrowRight");
    expect(onStepBeyondGrid).toHaveBeenLastCalledWith("media:m9", 1);
    await act(async () => {
      await Promise.resolve();
    });
    expect(focused).toBe(9);
  });

  it("focuses the key the session resolved once the appended page commits", async () => {
    onStepBeyondGrid.mockResolvedValueOnce("media:m10");
    mount(entries(10), 9);
    press("ArrowRight");
    await act(async () => {
      await Promise.resolve();
    });
    // The page has not rendered yet: focus waits.
    expect(focused).toBe(9);

    act(() => setEntries?.(entries(14)));
    expect(focused).toBe(10);
    expect(onSelectMedia).toHaveBeenLastCalledWith("m10");
  });

  it("focuses immediately when the resolved key is already loaded (a wrap)", async () => {
    onStepBeyondGrid.mockResolvedValueOnce("media:m0");
    mount(entries(10), 9);
    press("ArrowRight");
    await act(async () => {
      await Promise.resolve();
    });
    expect(focused).toBe(0);
  });
});
