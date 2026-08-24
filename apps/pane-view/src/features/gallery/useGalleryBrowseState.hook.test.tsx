// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { galleryListingKeys } from "@/features/library/library-queries";
import type { GalleryBrowseSearch } from "./browse-search";
import { createMemoryBrowseStorage, type MemoryBrowseStorage } from "./gallery-browse-storage";
import {
  type BrowseNavigate,
  browseSnapshotRequestFromSearch,
  type GalleryBrowseState,
  useGalleryBrowseState,
} from "./useGalleryBrowseState";

/**
 * The hook wiring around the pure module: one-shot redirect, mirroring into
 * the storage adapter (state and per-root prefs), and intents reaching the
 * router. The rules themselves are covered in useGalleryBrowseState.test.ts.
 */

const SEED = "0123456789abcdef0123456789abcdef";
const NEXT_SEED = "fedcba9876543210fedcba9876543210";
const settings = { showImages: true, showVideos: true };

describe("useGalleryBrowseState", () => {
  /** The search of the nth navigate call (negative counts from the end); the calls are asserted to exist first. */
  function emittedSearch(call: number): GalleryBrowseSearch {
    const options = navigate.mock.calls.at(call)?.[0];
    if (!options) throw new Error(`navigate call ${call} was not made`);
    return options.search;
  }

  let root: Root | undefined;
  let navigate: Mock<BrowseNavigate>;
  let latest: GalleryBrowseState | null;

  function mount(initialSearch: GalleryBrowseSearch, storage: MemoryBrowseStorage) {
    const container = document.createElement("div");
    let search = initialSearch;
    function Host(): ReactNode {
      latest = useGalleryBrowseState({
        createSeed: () => NEXT_SEED,
        navigate,
        search,
        settings,
        storage,
      });
      return null;
    }
    act(() => {
      root = createRoot(container);
      root.render(createElement(Host));
    });
    return {
      rerender(nextSearch: GalleryBrowseSearch) {
        search = nextSearch;
        act(() => root?.render(createElement(Host)));
      },
    };
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    navigate = vi.fn<BrowseNavigate>();
    latest = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    vi.unstubAllGlobals();
  });

  it("restores the persisted folder and flags once when the first route is the root", () => {
    const storage = createMemoryBrowseStorage({
      lastPath: "photos",
      randomSeed: SEED,
      recursive: true,
    });
    const host = mount({}, storage);

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith({
      search: { comic: undefined, media: undefined, path: "photos", q: undefined, recursive: true },
      to: "/",
    });

    host.rerender({});
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("stays at the root after explicitly navigating there from a persisted child folder", () => {
    const storage = createMemoryBrowseStorage({ lastPath: "photos", randomSeed: SEED });
    const host = mount({ path: "photos" }, storage);
    navigate.mockClear();

    host.rerender({});
    expect(navigate).not.toHaveBeenCalled();
    expect(latest?.path).toBe("");
  });

  it("mirrors the resolved state and per-root flags through the storage adapter", () => {
    const storage = createMemoryBrowseStorage({ randomSeed: SEED });
    const host = mount({ comic: true, path: "photos/2026" }, storage);

    expect(storage.state).toMatchObject({
      comicMode: true,
      lastPath: "photos/2026",
      randomSeed: SEED,
      recursive: true,
      sortMode: "name-asc",
    });
    expect(storage.rootPreferences).toEqual({
      photos: { comicMode: true, recursive: true, sortMode: "name-asc" },
    });

    host.rerender({ path: "photos/2026" });
    // The URL dropped the flags: they are off. The mirror recorded the last
    // in-folder choice, but it never resurrects a flag the URL does not carry.
    expect(latest).toMatchObject({ comicMode: false, recursive: false });
    expect(storage.state).toMatchObject({ comicMode: false, recursive: false });

    host.rerender({ path: "photos/2026", recursive: true });
    expect(storage.state).toMatchObject({ comicMode: false, recursive: true });

    // Visiting the root keeps the remembered in-folder flags (only navigateToPath("") forgets them).
    host.rerender({});
    expect(storage.state).toMatchObject({ comicMode: false, lastPath: "", recursive: true });
  });

  it("turns a mode off round-trip: the emitted URL resolves to off and stays off", () => {
    const storage = createMemoryBrowseStorage({ randomSeed: SEED });
    const host = mount({ path: "photos", recursive: true }, storage);
    expect(latest?.recursive).toBe(true);
    navigate.mockClear();

    act(() => latest?.setRecursive(false));
    const emitted = emittedSearch(0);
    expect(emitted).toEqual({
      comic: undefined,
      media: undefined,
      path: "photos",
      q: undefined,
      recursive: undefined,
    });

    host.rerender(emitted);
    expect(latest).toMatchObject({ comicMode: false, recursive: false });
    expect(latest?.snapshotRequest).toEqual(browseSnapshotRequestFromSearch(emitted));
    expect(storage.state).toMatchObject({ comicMode: false, recursive: false });

    act(() => latest?.setComicMode(true));
    const withComic = emittedSearch(1);
    expect(withComic).toMatchObject({ comic: true, recursive: true });
    host.rerender(withComic);
    expect(latest).toMatchObject({ comicMode: true, recursive: true });

    act(() => latest?.setComicMode(false));
    const off = emittedSearch(2);
    expect(off).toMatchObject({ comic: undefined, recursive: undefined });
    host.rerender(off);
    expect(latest).toMatchObject({ comicMode: false, recursive: false });
  });

  it("applies the settings-drawer default when entering a folder from the root", () => {
    const storage = createMemoryBrowseStorage({ randomSeed: SEED });
    const host = mount({}, storage);
    act(() => latest?.setRecursive(true));
    expect(navigate).not.toHaveBeenCalled();
    expect(storage.state).toMatchObject({ recursive: true });

    act(() => latest?.navigateToPath("photos"));
    expect(navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({ path: "photos", recursive: true }),
      }),
    );

    // Turning it off inside the folder updates the default too.
    host.rerender({ path: "photos", recursive: true });
    act(() => latest?.setRecursive(false));
    host.rerender(emittedSearch(-1));
    expect(storage.state).toMatchObject({ comicMode: false, recursive: false });
    act(() => latest?.navigateToPath(""));
    host.rerender({});
    act(() => latest?.navigateToPath("photos"));
    expect(navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({ path: "photos", recursive: undefined }),
      }),
    );
  });

  it("creates and persists a seed when none is stored, and keeps it across renders", () => {
    const storage = createMemoryBrowseStorage({});
    const host = mount({ path: "photos" }, storage);
    expect(latest?.randomSeed).toBe(NEXT_SEED);
    expect(storage.state?.randomSeed).toBe(NEXT_SEED);
    host.rerender({ path: "photos", q: "x" });
    expect(latest?.randomSeed).toBe(NEXT_SEED);
  });

  it("writes local fields to storage and URL fields to the router", () => {
    const storage = createMemoryBrowseStorage({ randomSeed: SEED });
    mount({ path: "photos" }, storage);
    navigate.mockClear();

    act(() => latest?.setSortMode("date-newest"));
    expect(latest?.sortMode).toBe("date-newest");
    expect(storage.state?.sortMode).toBe("date-newest");
    expect(latest?.listingRequest.sortMode).toBe("date-newest");

    act(() => latest?.shuffle());
    expect(latest?.sortMode).toBe("random");
    expect(latest?.randomSeed).toBe(NEXT_SEED);
    expect(navigate).not.toHaveBeenCalled();

    act(() => latest?.selectMedia("m-1"));
    expect(navigate).toHaveBeenLastCalledWith({
      replace: true,
      resetScroll: false,
      search: {
        comic: undefined,
        media: "m-1",
        path: "photos",
        q: undefined,
        recursive: undefined,
      },
      to: "/",
    });

    act(() => latest?.setRecursive(true));
    expect(navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replace: true,
        search: expect.objectContaining({ recursive: true }),
      }),
    );
  });

  it("threads the current path's stored excludes into the requests while recursive is on", () => {
    const storage = createMemoryBrowseStorage(
      { randomSeed: SEED },
      { photos: ["photos/kids"], videos: ["videos/raw"] },
    );
    const host = mount({ path: "photos", recursive: true }, storage);
    expect(latest?.excludedChildPaths).toEqual(["photos/kids"]);
    expect(latest?.snapshotRequest.excludedPaths).toEqual(["photos/kids"]);
    expect(latest?.listingRequest.excludedPaths).toEqual(["photos/kids"]);

    // Navigating to another path swaps to that path's own list.
    host.rerender({ path: "videos", recursive: true });
    expect(latest?.excludedChildPaths).toEqual(["videos/raw"]);
    expect(latest?.listingRequest.excludedPaths).toEqual(["videos/raw"]);
    host.rerender({ path: "videos/raw", recursive: true });
    expect(latest?.excludedChildPaths).toEqual([]);
    expect(latest?.listingRequest.excludedPaths).toBeUndefined();

    // Recursive off: the list stays readable but leaves every request.
    host.rerender({ path: "photos" });
    expect(latest?.excludedChildPaths).toEqual(["photos/kids"]);
    expect(latest?.snapshotRequest.excludedPaths).toBeUndefined();
    expect(latest?.listingRequest.excludedPaths).toBeUndefined();
  });

  it("toggling an exclude writes through to storage and changes the listing query key", () => {
    const storage = createMemoryBrowseStorage({ randomSeed: SEED });
    mount({ path: "photos", recursive: true }, storage);
    const before = latest?.listingRequest;
    if (!before) throw new Error("listing request missing");

    act(() => latest?.toggleExcludedChild("photos/kids"));
    expect(storage.recursiveExcludes).toEqual({ photos: ["photos/kids"] });
    expect(latest?.listingRequest.excludedPaths).toEqual(["photos/kids"]);
    // The query key hashes to JSON, so the toggled request refetches immediately.
    expect(JSON.stringify(galleryListingKeys.listing(before))).not.toBe(
      JSON.stringify(galleryListingKeys.listing(latest?.listingRequest ?? before)),
    );

    act(() => latest?.toggleExcludedChild("photos/kids"));
    expect(storage.recursiveExcludes).toEqual({});
    expect(latest?.listingRequest.excludedPaths).toBeUndefined();
  });

  it("prunes only genuinely absent paths and persists the pruned list", () => {
    const storage = createMemoryBrowseStorage(
      { randomSeed: SEED },
      { photos: ["photos/kids", "photos/gone"], videos: ["videos/raw"] },
    );
    mount({ path: "photos", recursive: true }, storage);

    act(() => latest?.pruneExcludedChildren(["photos/kids", "photos/other"]));
    expect(storage.recursiveExcludes).toEqual({
      photos: ["photos/kids"],
      videos: ["videos/raw"],
    });
    expect(latest?.excludedChildPaths).toEqual(["photos/kids"]);

    // Nothing absent: no write, no state change.
    const list = latest?.excludedChildPaths;
    act(() => latest?.pruneExcludedChildren(["photos/kids"]));
    expect(latest?.excludedChildPaths).toBe(list);
  });

  it("keeps the snapshot request referentially stable across unrelated rerenders", () => {
    const storage = createMemoryBrowseStorage({ randomSeed: SEED });
    const host = mount({ path: "photos" }, storage);
    const first = latest?.snapshotRequest;
    expect(first).toEqual({
      comicMode: false,
      mediaLimit: 0,
      path: "photos",
      query: undefined,
      recursive: false,
    });

    act(() => latest?.setDetailPanelOpen(false));
    expect(latest?.snapshotRequest).toBe(first);

    host.rerender({ path: "photos", media: "m-1" });
    expect(latest?.snapshotRequest).toBe(first);
  });
});
