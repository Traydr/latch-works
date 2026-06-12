import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveHashFiles,
  resolveLocalFilePath,
  selectChangedItemsForPush,
} from "./push-helpers.js";

describe("resolveHashFiles", () => {
  it("always hashes during push even when capped", () => {
    expect(
      resolveHashFiles({
        command: "push",
        hashFiles: false,
      }),
    ).toBe(true);
  });

  it("keeps plan hashing opt-in", () => {
    expect(
      resolveHashFiles({
        command: "plan",
        hashFiles: false,
      }),
    ).toBe(false);
  });
});

describe("selectChangedItemsForPush", () => {
  it("warns when capped batches omit deletes", () => {
    const changedItems = [
      { action: "upload", path: "a.jpg" },
      { action: "upload", path: "b.jpg" },
      { action: "delete", path: "old.jpg" },
    ];

    const result = selectChangedItemsForPush(changedItems, 2);

    expect(result.items).toHaveLength(2);
    expect(result.omittedDeleteCount).toBe(1);
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
