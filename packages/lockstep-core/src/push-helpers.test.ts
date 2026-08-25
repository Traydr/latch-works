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
});
