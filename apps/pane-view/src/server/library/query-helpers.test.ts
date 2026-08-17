import { describe, expect, it } from "vitest";
import { escapeLikePattern, resolveMediaScope } from "./query-helpers";

describe("resolveMediaScope", () => {
  it("scopes to direct children when non-recursive", () => {
    expect(
      resolveMediaScope({ currentPath: "photos/2026", recursive: false, searching: false }),
    ).toEqual({
      mode: "direct-children",
      parentPath: "photos/2026",
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
      resolveMediaScope({ currentPath: "photos/2026", recursive: true, searching: false }),
    ).toEqual({
      mode: "subtree",
      pathPrefix: "photos/2026",
    });
  });

  it("loads entire archive when recursive at root", () => {
    expect(resolveMediaScope({ currentPath: "", recursive: true, searching: false })).toEqual({
      mode: "all",
    });
  });

  it("uses search mode when query is active", () => {
    expect(resolveMediaScope({ currentPath: "media", recursive: false, searching: true })).toEqual({
      mode: "search",
    });
  });
});

describe("escapeLikePattern", () => {
  it("escapes like wildcards", () => {
    expect(escapeLikePattern("100%_done")).toBe("100\\%\\_done");
  });
});
