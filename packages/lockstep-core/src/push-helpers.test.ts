import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLocalFilePath } from "./push-helpers.js";

describe("resolveLocalFilePath", () => {
  it("rejects paths that escape the source root", () => {
    const sourceRoot = path.resolve("/tmp/archive");
    expect(() => resolveLocalFilePath(sourceRoot, "../outside.jpg")).toThrow(
      "Local path escapes source root",
    );
  });

  it("accepts names that only start with two dots", () => {
    const sourceRoot = path.resolve("/tmp/archive");
    expect(resolveLocalFilePath(sourceRoot, "..cover.jpg")).toBe(
      path.join(sourceRoot, "..cover.jpg"),
    );
    expect(resolveLocalFilePath(sourceRoot, "..drafts/page.jpg")).toBe(
      path.join(sourceRoot, "..drafts", "page.jpg"),
    );
    expect(() => resolveLocalFilePath(sourceRoot, "photos/../../outside.jpg")).toThrow(
      "Local path escapes source root",
    );
  });
});
