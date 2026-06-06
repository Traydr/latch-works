import { describe, expect, it } from "vitest";
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
