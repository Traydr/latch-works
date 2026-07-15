import { describe, expect, it } from "vitest";
import { isGatherOutputKind } from "./executor";

describe("Gather Output selection", () => {
  it.each(["downloadable-files", "generated-story-pdf"])("accepts %s", (kind) => {
    expect(isGatherOutputKind(kind)).toBe(true);
  });

  it("rejects unknown output implementations", () => {
    expect(isGatherOutputKind("remote-script")).toBe(false);
    expect(isGatherOutputKind(null)).toBe(false);
  });
});
