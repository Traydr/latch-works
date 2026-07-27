import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHashMode, resolveLocalFilePath, selectUploadUpdateItems } from "./push-helpers.js";

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

describe("resolveLocalFilePath", () => {
  it("rejects paths that escape the source root", () => {
    const sourceRoot = path.resolve("/tmp/archive");
    expect(() => resolveLocalFilePath(sourceRoot, "../outside.jpg")).toThrow(
      "Local path escapes source root",
    );
  });
});
