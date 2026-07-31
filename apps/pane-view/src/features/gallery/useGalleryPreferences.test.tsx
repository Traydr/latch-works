// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GalleryBrowseSearch } from "./browse-search";
import { useGalleryPreferences } from "./useGalleryPreferences";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  saveRootPreferences: vi.fn(),
  setPreferences: vi.fn(),
}));

vi.mock("./useGalleryState", () => ({
  GALLERY_STATE_DEFAULTS: {
    comicMode: false,
    detailPanelOpen: true,
    lastPath: "",
    lastSelectedId: null,
    recursive: false,
    sortMode: "name-asc",
  },
  useGalleryState: () => ({
    comicMode: false,
    detailPanelOpen: true,
    isReady: true,
    lastPath: "photos",
    lastSelectedId: null,
    recursive: false,
    setPreferences: mocks.setPreferences,
    sortMode: "name-asc",
  }),
}));

vi.mock("@/features/settings/useAppSettings", () => ({
  resolveRootKey: (path: string) => path.split("/")[0] ?? "",
  useRootPreferences: () => ({ savePreferences: mocks.saveRootPreferences }),
}));

describe("useGalleryPreferences", () => {
  let root: Root | undefined;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.navigate.mockReset();
    mocks.saveRootPreferences.mockReset();
    mocks.setPreferences.mockReset();
  });

  afterEach(() => {
    act(() => root?.unmount());
    vi.unstubAllGlobals();
  });

  it("stays at the archive root after explicitly navigating from a persisted child folder", () => {
    const container = document.createElement("div");
    let search: GalleryBrowseSearch = { path: "photos" };

    function Host(): ReactNode {
      useGalleryPreferences({
        displayPath: search.path ?? "",
        hydrated: true,
        navigate: mocks.navigate,
        search,
      });
      return null;
    }

    act(() => {
      root = createRoot(container);
      root.render(createElement(Host));
    });
    mocks.navigate.mockClear();

    search = {};
    act(() => root?.render(createElement(Host)));

    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("restores the persisted folder once when the initial hydrated route is the root", () => {
    const container = document.createElement("div");
    const search: GalleryBrowseSearch = {};

    function Host(): ReactNode {
      useGalleryPreferences({
        displayPath: "",
        hydrated: true,
        navigate: mocks.navigate,
        search,
      });
      return null;
    }

    act(() => {
      root = createRoot(container);
      root.render(createElement(Host));
    });
    act(() => root?.render(createElement(Host)));

    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith({
      search: {
        comic: undefined,
        media: undefined,
        path: "photos",
        q: undefined,
        recursive: undefined,
      },
      to: "/",
    });
  });
});
