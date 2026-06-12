import { describe, expect, it } from "vitest";
import { buildMediaPage } from "./media-page";
import { escapeLikePatternForTest, resolveMediaScope } from "./query-helpers";

describe("resolveMediaScope", () => {
  it("scopes to direct children when non-recursive", () => {
    expect(resolveMediaScope({ currentPath: "sfw/patreon", recursive: false, searching: false })).toEqual({
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
    expect(resolveMediaScope({ currentPath: "sfw/patreon", recursive: true, searching: false })).toEqual({
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
