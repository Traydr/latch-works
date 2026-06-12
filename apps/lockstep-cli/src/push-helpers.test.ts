import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveHashFiles,
  resolveLocalFilePath,
  selectChangedItemsForPush,
  selectUploadUpdateItems,
} from "./push-helpers.js";

describe("resolveHashFiles", () => {
  it("always hashes during push even when capped", () => {
    expect(
      resolveHashFiles({
        requireHash: true,
      }),
    ).toBe(true);
  });

  it("keeps plan hashing opt-in", () => {
    expect(
      resolveHashFiles({
        hashFiles: false,
      }),
    ).toBe(false);
  });
});

describe("selectChangedItemsForPush", () => {
  it("excludes deletes from push batches", () => {
    const changedItems = [
      { action: "upload", path: "a.jpg" },
      { action: "upload", path: "b.jpg" },
      { action: "delete", path: "old.jpg" },
    ];

    const result = selectChangedItemsForPush(changedItems, 2);

    expect(result.items).toHaveLength(2);
    expect(result.items.every((item) => item.action !== "delete")).toBe(true);
  });
});

describe("selectUploadUpdateItems", () => {
  it("caps upload/update items only", () => {
    const changedItems = [
      { action: "upload" as const, path: "a.jpg" },
      { action: "upload" as const, path: "b.jpg" },
      { action: "delete" as const, path: "old.jpg" },
    ];

    const result = selectUploadUpdateItems(changedItems, 1);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.action).toBe("upload");
  });
});

describe("resolveLocalFilePath", () => {
  it("resolves valid archive paths inside the source root", () => {
    const sourceRoot = path.resolve("/tmp/archive");
    expect(resolveLocalFilePath(sourceRoot, "photos/cover.jpg")).toBe(
      path.resolve(sourceRoot, "photos/cover.jpg"),
    );
  });

  it("rejects paths that escape the source root", () => {
    const sourceRoot = path.resolve("/tmp/archive");
    expect(() => resolveLocalFilePath(sourceRoot, "../outside.jpg")).toThrow(
      "Local path escapes source root",
    );
  });
});
