import { describe, expect, it } from "vitest";
import { buildComicEntries } from "@latch-works/media-domain";
import { buildMediaPage } from "./media-page";
import { escapeLikePatternForTest, resolveMediaScope } from "./query-helpers";

function mapAllFolderHasChildren(
  allFolderRows: Array<{ parentPath: string | null; path: string }>,
): Map<string, boolean> {
  const folderParentPathsWithChildFolders = new Set(
    allFolderRows
      .map((folder) => folder.parentPath)
      .filter((parentPath): parentPath is string => Boolean(parentPath)),
  );

  return new Map(
    allFolderRows.map((folder) => [folder.path, folderParentPathsWithChildFolders.has(folder.path)]),
  );
}

describe("comic folder metadata", () => {
  it("marks all-folder leaf status from child folders only", () => {
    const allFolders = [
      { parentPath: "sfw", path: "sfw/parent" },
      { parentPath: "sfw/parent", path: "sfw/parent/leaf" },
    ];
    const hasChildrenByPath = mapAllFolderHasChildren(allFolders);

    expect(hasChildrenByPath.get("sfw/parent")).toBe(true);
    expect(hasChildrenByPath.get("sfw/parent/leaf")).toBe(false);
  });

  it("keeps leaf-folder comic grouping behavior", () => {
    const comics = buildComicEntries(
      [
        {
          extension: "jpg",
          id: "page-1",
          mediaType: "image",
          mtimeMs: 1,
          name: "page-1.jpg",
          parentPath: "sfw/parent/leaf",
          path: "sfw/parent/leaf/page-1.jpg",
          size: 1,
        },
      ],
      "sfw/parent",
      {
        folders: [
          {
            parentPath: "sfw",
          },
          {
            parentPath: "sfw/parent",
          },
        ],
        leafFoldersOnly: true,
      },
    );

    expect(comics).toHaveLength(1);
    expect(comics[0]?.folderPath).toBe("sfw/parent/leaf");
  });
});

describe("resolveMediaScope", () => {
  it("scopes to direct children when non-recursive", () => {
    expect(
      resolveMediaScope({ currentPath: "sfw/patreon", recursive: false, searching: false }),
    ).toEqual({
      mode: "direct-children",
      parentPath: "sfw/patreon",
    });
  });

  it("scopes to archive root children when non-recursive at root", () => {
    expect(resolveMediaScope({ currentPath: "", recursive: false, searching: false })).toEqual({
      mode: "direct-children",
      parentPath: "",
    });
  });

  it("scopes to subtree when recursive in a folder", () => {
    expect(
      resolveMediaScope({ currentPath: "sfw/patreon", recursive: true, searching: false }),
    ).toEqual({
      mode: "subtree",
      pathPrefix: "sfw/patreon",
    });
  });

  it("loads entire archive when recursive at root", () => {
    expect(resolveMediaScope({ currentPath: "", recursive: true, searching: false })).toEqual({
      mode: "all",
    });
  });

  it("uses search mode when query is active", () => {
    expect(resolveMediaScope({ currentPath: "sfw", recursive: false, searching: true })).toEqual({
      mode: "search",
    });
  });
});

describe("escapeLikePatternForTest", () => {
  it("escapes like wildcards", () => {
    expect(escapeLikePatternForTest("100%_done")).toBe("100\\%\\_done");
  });
});

describe("buildMediaPage", () => {
  it("returns hasMore when overfetch finds an extra row", () => {
    const rows = ["a", "b", "c"];
    const page = buildMediaPage(rows, 2, 0);

    expect(page.items).toEqual(["a", "b"]);
    expect(page.mediaPage).toEqual({
      hasMore: true,
      limit: 2,
      nextOffset: 2,
      offset: 0,
    });
  });

  it("returns no next page when rows fit within the limit", () => {
    const rows = ["a", "b"];
    const page = buildMediaPage(rows, 2, 4);

    expect(page.items).toEqual(["a", "b"]);
    expect(page.mediaPage).toEqual({
      hasMore: false,
      limit: 2,
      nextOffset: null,
      offset: 4,
    });
  });

  it("keeps deterministic pages without duplicated rows across offsets", () => {
    const rows = ["a", "b", "c", "d", "e"];
    const firstPage = buildMediaPage(rows.slice(0, 3), 2, 0);
    const secondPage = buildMediaPage(rows.slice(2), 2, 2);
    const merged = [...firstPage.items, ...secondPage.items];
    const unique = new Set(merged);

    expect(firstPage.items).toEqual(["a", "b"]);
    expect(secondPage.items).toEqual(["c", "d"]);
    expect(merged).toHaveLength(unique.size);
  });
});
