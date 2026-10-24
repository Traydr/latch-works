import { describe, expect, it } from "vitest";

import { isInside, knownFolders } from "../../src/main/folders";
import { baseName, closestFolder, parentOf, relativeInside } from "../../src/shell/paths";

describe("knownFolders", () => {
  it("merges each mode's folders, naming the modes that use each, old apps' last", () => {
    expect(
      knownFolders({
        view: () => "/archive/photos",
        tidy: () => ["/archive", "/archive/photos"],
        sync: () => ["/archive/"],
        migrated: () => ["/old", "/archive"],
      }),
    ).toEqual([
      { path: "/archive/photos", modes: ["view", "tidy"] },
      { path: "/archive", modes: ["tidy", "sync"] },
      { path: "/old", modes: [] },
    ]);
  });
});

describe("isInside", () => {
  it("holds the folder itself and what is under it, not a sibling sharing its prefix", () => {
    expect(isInside("/archive", "/archive")).toBe(true);
    expect(isInside("/archive", "/archive/2021/a.jpg")).toBe(true);
    expect(isInside("/archive", "/archive-old/a.jpg")).toBe(false);
    expect(isInside("/archive", "/archive/../etc")).toBe(false);
  });
});

describe("window paths", () => {
  it("places a path inside a folder with / between names", () => {
    expect(relativeInside("/archive", "/archive")).toBe("");
    expect(relativeInside("/archive/", "/archive/2021/trip")).toBe("2021/trip");
    expect(relativeInside("/archive", "/archive-old")).toBeNull();
    expect(relativeInside("C:\\Archive", "C:\\Archive\\2021\\trip")).toBe("2021/trip");
  });

  it("splits names and parents on either separator, keeping a root's", () => {
    expect(baseName("/archive/2021/a.jpg")).toBe("a.jpg");
    expect(baseName("C:\\Archive\\")).toBe("Archive");
    expect(parentOf("/archive/a.jpg")).toBe("/archive");
    expect(parentOf("/a.jpg")).toBe("/");
    expect(parentOf("C:\\a.jpg")).toBe("C:\\");
  });

  it("picks the closest folder that holds a path", () => {
    const folders = [{ path: "/archive" }, { path: "/archive/2021" }, { path: "/other" }];

    expect(closestFolder(folders, "/archive/2021/trip")).toEqual({ path: "/archive/2021" });
    expect(closestFolder(folders, "/archive/2020")).toEqual({ path: "/archive" });
    expect(closestFolder(folders, "/elsewhere")).toBeNull();
  });
});
