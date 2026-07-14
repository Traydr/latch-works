import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveHashFiles,
  resolveHashMode,
  resolveLocalFilePath,
  selectDeleteItems,
  selectUploadUpdateItems,
} from "./push-helpers.js";

describe("resolveHashFiles", () => {
  it("hashes when required", () => {
    expect(resolveHashFiles({ requireHash: true })).toBe(true);
  });

  it("keeps plan hashing opt-in", () => {
    expect(resolveHashFiles({ hashFiles: false })).toBe(false);
  });
});

describe("resolveHashMode", () => {
  it("uses an explicit mode before the legacy boolean", () => {
    expect(resolveHashMode({ hashFiles: true, hashMode: "remote-aware" })).toBe("remote-aware");
  });

  it("maps the legacy boolean and supports a default", () => {
    expect(resolveHashMode({ hashFiles: true })).toBe("all");
    expect(resolveHashMode({ hashFiles: false })).toBe("none");
    expect(resolveHashMode({ defaultMode: "remote-aware" })).toBe("remote-aware");
  });
});

describe("selectUploadUpdateItems", () => {
  it("excludes deletes from push batches", () => {
    const changedItems = [
      { action: "upload" as const, path: "a.jpg" },
      { action: "delete" as const, path: "old.jpg" },
    ];

    const result = selectUploadUpdateItems(changedItems);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.action).toBe("upload");
  });

  it("caps upload/update items", () => {
    const changedItems = [
      { action: "upload" as const, path: "a.jpg" },
      { action: "upload" as const, path: "b.jpg" },
      { action: "upload" as const, path: "c.jpg" },
    ];

    const result = selectUploadUpdateItems(changedItems, 2);

    expect(result.items).toHaveLength(2);
    expect(result.omittedCount).toBe(1);
  });
});

describe("selectDeleteItems", () => {
  it("selects only delete actions", () => {
    const changedItems = [
      { action: "upload" as const, path: "a.jpg" },
      { action: "delete" as const, path: "old.jpg" },
    ];

    const result = selectDeleteItems(changedItems);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.action).toBe("delete");
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
