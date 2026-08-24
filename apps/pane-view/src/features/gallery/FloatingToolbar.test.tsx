// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FloatingToolbar } from "@/features/gallery/FloatingToolbar";
import { createMemoryBrowseStorage } from "@/features/gallery/gallery-browse-storage";
import { useGalleryBrowseState } from "@/features/gallery/useGalleryBrowseState";

/**
 * The exclude affordance (Plan 054, Decisions 4–5): the folder button exists
 * only in recursive/comic mode, disables without children, carries a dot while
 * the active list is non-empty, and its dialog toggles round-trip through the
 * browse-session intent into storage.
 */

type ToolbarProps = Parameters<typeof FloatingToolbar>[0];

const SEED = "0123456789abcdef0123456789abcdef";
const CHILDREN = [
  { name: "kids", path: "photos/kids" },
  { name: "teens", path: "photos/teens" },
];

function toolbarProps(overrides: Partial<ToolbarProps> = {}): ToolbarProps {
  return {
    childFolders: [],
    childFoldersAreCurrent: true,
    comicMode: false,
    currentPath: "photos",
    excludedChildPaths: [],
    isRefreshing: false,
    onChangeSortMode: vi.fn(),
    onExcludeDialogOpen: vi.fn(),
    onRefresh: vi.fn(),
    onToggleComicMode: vi.fn(),
    onToggleExcludedChild: vi.fn(),
    onToggleRecursive: vi.fn(),
    recursive: false,
    shuffle: vi.fn(),
    sortMode: "name-asc",
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root | undefined;

function render(node: ReactNode): void {
  act(() => {
    root = createRoot(container);
    root.render(node);
  });
}

function rerender(node: ReactNode): void {
  act(() => root?.render(node));
}

function excludeButton(): HTMLButtonElement | null {
  return (
    container.querySelector<HTMLButtonElement>('button[title="Exclude subfolders"]') ??
    container.querySelector<HTMLButtonElement>('button[title="No subfolders to exclude"]')
  );
}

function click(element: Element | null): void {
  if (!element) throw new Error("expected an element to click");
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("FloatingToolbar exclude button", () => {
  it("exists only while recursive or comic mode is on", () => {
    render(createElement(FloatingToolbar, toolbarProps({ childFolders: CHILDREN })));
    expect(excludeButton()).toBeNull();

    rerender(
      createElement(FloatingToolbar, toolbarProps({ childFolders: CHILDREN, recursive: true })),
    );
    expect(excludeButton()).not.toBeNull();

    rerender(
      createElement(
        FloatingToolbar,
        toolbarProps({ childFolders: CHILDREN, comicMode: true, recursive: true }),
      ),
    );
    expect(excludeButton()).not.toBeNull();
  });

  it("disables with a tooltip when the current path has no child folders", () => {
    render(createElement(FloatingToolbar, toolbarProps({ recursive: true })));
    const button = excludeButton();
    expect(button?.disabled).toBe(true);
    expect(button?.title).toBe("No subfolders to exclude");
  });

  it("carries a dot exactly while the active exclude list is non-empty", () => {
    const props = toolbarProps({ childFolders: CHILDREN, recursive: true });
    render(createElement(FloatingToolbar, props));
    expect(excludeButton()?.querySelector(".rounded-full")).toBeNull();

    rerender(
      createElement(FloatingToolbar, { ...props, excludedChildPaths: ["photos/kids"] }),
    );
    expect(excludeButton()?.querySelector(".rounded-full")).not.toBeNull();

    rerender(createElement(FloatingToolbar, { ...props, excludedChildPaths: [] }));
    expect(excludeButton()?.querySelector(".rounded-full")).toBeNull();
  });

  it("lists the children on open, fires the auto-prune, and toggles one row per click", () => {
    const props = toolbarProps({
      childFolders: CHILDREN,
      excludedChildPaths: ["photos/kids"],
      recursive: true,
    });
    render(createElement(FloatingToolbar, props));

    click(excludeButton());
    expect(props.onExcludeDialogOpen).toHaveBeenCalledTimes(1);
    const rows = [...container.querySelectorAll('[role="menuitemcheckbox"]')];
    expect(rows.map((row) => row.textContent)).toEqual(["kidsExcluded", "teensIncluded"]);
    expect(rows.map((row) => row.getAttribute("aria-checked"))).toEqual(["true", "false"]);

    click(rows[1] ?? null);
    expect(props.onToggleExcludedChild).toHaveBeenCalledExactlyOnceWith("photos/teens");
  });

  it("withholds the auto-prune while the children are not current", () => {
    const props = toolbarProps({
      childFolders: CHILDREN,
      childFoldersAreCurrent: false,
      recursive: true,
    });
    render(createElement(FloatingToolbar, props));

    click(excludeButton());
    expect(container.querySelector('[role="menuitemcheckbox"]')).not.toBeNull();
    expect(props.onExcludeDialogOpen).not.toHaveBeenCalled();
  });

  it("round-trips a dialog toggle through the browse-session intent and storage", () => {
    const storage = createMemoryBrowseStorage({ randomSeed: SEED });
    function Host(): ReactNode {
      const browse = useGalleryBrowseState({
        navigate: vi.fn(),
        search: { path: "photos", recursive: true },
        settings: { showImages: true, showVideos: true },
        storage,
      });
      return createElement(
        FloatingToolbar,
        toolbarProps({
          childFolders: CHILDREN,
          excludedChildPaths: browse.excludedChildPaths,
          onToggleExcludedChild: browse.toggleExcludedChild,
          recursive: browse.recursive,
        }),
      );
    }
    render(createElement(Host));

    click(excludeButton());
    const row = container.querySelector('[role="menuitemcheckbox"]');
    click(row);
    expect(storage.recursiveExcludes).toEqual({ photos: ["photos/kids"] });
    expect(container.querySelector('[role="menuitemcheckbox"]')?.getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(excludeButton()?.querySelector(".rounded-full")).not.toBeNull();

    click(row);
    expect(storage.recursiveExcludes).toEqual({});
    expect(excludeButton()?.querySelector(".rounded-full")).toBeNull();
  });
});
