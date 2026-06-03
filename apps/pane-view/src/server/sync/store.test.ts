import { describe, expect, it } from "vitest";
import { collectContainingFolderPaths } from "./store";

describe("sync store helpers", () => {
  it("collects every parent folder needed for path navigation", () => {
    expect(collectContainingFolderPaths("nsfw/comics/creator/post")).toEqual([
      "nsfw",
      "nsfw/comics",
      "nsfw/comics/creator",
      "nsfw/comics/creator/post",
    ]);
  });

  it("ignores empty path segments", () => {
    expect(collectContainingFolderPaths("sfw//patreon/creator/")).toEqual([
      "sfw",
      "sfw/patreon",
      "sfw/patreon/creator",
    ]);
  });
});
