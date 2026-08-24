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
type ExcludeProps = ToolbarProps["exclude"];

const SEED = "0123456789abcdef0123456789abcdef";
const CHILDREN = [
  { name: "kids", path: "photos/kids" },
  { name: "teens", path: "photos/teens" },
];

function excludeProps(overrides: Partial<ExcludeProps> = {}): ExcludeProps {
  return {
    childFolders: [],
    childFoldersAreCurrent: true,
    excludedChildPaths: [],
    onDialogOpen: vi.fn(),
    onToggle: vi.fn(),
    ...overrides,
  };
}

function toolbarProps(
  overrides: Partial<Omit<ToolbarProps, "exclude">> & { exclude?: Partial<ExcludeProps> } = {},
): ToolbarProps {
  return {
    comicMode: false,
    currentPath: "photos",
    isRefreshing: false,
    onChangeSortMode: vi.fn(),
    onRefresh: vi.fn(),
    onToggleComicMode: vi.fn(),
    onToggleRecursive: vi.fn(),
    recursive: false,
    shuffle: vi.fn(),
    sortMode: "name-asc",
    ...overrides,
    exclude: excludeProps(overrides.exclude),
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
    const exclude = { childFolders: CHILDREN };
    render(createElement(FloatingToolbar, toolbarProps({ exclude })));
    expect(excludeButton()).toBeNull();

    rerender(createElement(FloatingToolbar, toolbarProps({ exclude, recursive: true })));
    expect(excludeButton()).not.toBeNull();

    rerender(
      createElement(FloatingToolbar, toolbarProps({ comicMode: true, exclude, recursive: true })),
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
    const props = toolbarProps({ exclude: { childFolders: CHILDREN }, recursive: true });
    render(createElement(FloatingToolbar, props));
    expect(excludeButton()?.querySelector(".rounded-full")).toBeNull();

    rerender(
      createElement(FloatingToolbar, {
        ...props,
        exclude: { ...props.exclude, excludedChildPaths: ["photos/kids"] },
      }),
    );
    expect(excludeButton()?.querySelector(".rounded-full")).not.toBeNull();

    rerender(createElement(FloatingToolbar, props));
    expect(excludeButton()?.querySelector(".rounded-full")).toBeNull();
  });

  it("lists the children on open, fires the auto-prune, and toggles one row per click", () => {
    const props = toolbarProps({
      exclude: { childFolders: CHILDREN, excludedChildPaths: ["photos/kids"] },
      recursive: true,
    });
    render(createElement(FloatingToolbar, props));

    click(excludeButton());
    expect(props.exclude.onDialogOpen).toHaveBeenCalledTimes(1);
    const rows = [...container.querySelectorAll('[role="menuitemcheckbox"]')];
    expect(rows.map((row) => row.textContent)).toEqual(["kidsExcluded", "teensIncluded"]);
    expect(rows.map((row) => row.getAttribute("aria-checked"))).toEqual(["true", "false"]);

    click(rows[1] ?? null);
    expect(props.exclude.onToggle).toHaveBeenCalledExactlyOnceWith("photos/teens");
  });

  it("keeps the open dialog's element and rows mounted across a toggle", () => {
    // Scroll position lives on the menu element; a remount (or a collapsed
    // row list) would reset it to the top mid-interaction.
    const props = toolbarProps({ exclude: { childFolders: CHILDREN }, recursive: true });
    render(createElement(FloatingToolbar, props));
    click(excludeButton());
    const menu = container.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();

    rerender(
      createElement(FloatingToolbar, {
        ...props,
        exclude: { ...props.exclude, excludedChildPaths: ["photos/kids"] },
      }),
    );
    expect(container.querySelector('[role="menu"]')).toBe(menu);
    expect(container.querySelectorAll('[role="menuitemcheckbox"]')).toHaveLength(CHILDREN.length);
  });

  it("closes the dialog on navigation, when leaving the mode, and when the set empties", () => {
    const props = toolbarProps({ exclude: { childFolders: CHILDREN }, recursive: true });
    render(createElement(FloatingToolbar, props));
    click(excludeButton());
    expect(container.querySelector('[role="menu"]')).not.toBeNull();

    rerender(createElement(FloatingToolbar, { ...props, currentPath: "photos/kids" }));
    expect(container.querySelector('[role="menu"]')).toBeNull();

    click(excludeButton());
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
    rerender(
      createElement(FloatingToolbar, {
        ...props,
        currentPath: "photos/kids",
        exclude: { ...props.exclude, childFolders: [] },
      }),
    );
    expect(container.querySelector('[role="menu"]')).toBeNull();

    rerender(createElement(FloatingToolbar, { ...props, currentPath: "photos/kids" }));
    click(excludeButton());
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
    rerender(
      createElement(FloatingToolbar, { ...props, currentPath: "photos/kids", recursive: false }),
    );
    expect(excludeButton()).toBeNull();
    rerender(createElement(FloatingToolbar, { ...props, currentPath: "photos/kids" }));
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it("disables the button while the children are not yet current", () => {
    // The snapshot's rows linger through a navigation; until the new folder's
    // children land, the button must neither open the old list nor prune
    // against it.
    const props = toolbarProps({
      exclude: { childFolders: CHILDREN, childFoldersAreCurrent: false },
      recursive: true,
    });
    render(createElement(FloatingToolbar, props));

    expect(excludeButton()?.disabled).toBe(true);
    click(excludeButton());
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(props.exclude.onDialogOpen).not.toHaveBeenCalled();

    rerender(
      createElement(FloatingToolbar, {
        ...props,
        exclude: { ...props.exclude, childFoldersAreCurrent: true },
      }),
    );
    expect(excludeButton()?.disabled).toBe(false);
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
          exclude: {
            childFolders: CHILDREN,
            excludedChildPaths: browse.excludedChildPaths,
            onToggle: browse.toggleExcludedChild,
          },
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
