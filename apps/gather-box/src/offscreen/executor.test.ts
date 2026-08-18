import { describe, expect, it } from "vitest";
import { GatherOutputKindSchema } from "../shared/source-catalog";

describe("Gather Output selection", () => {
  it.each(["downloadable-files", "generated-story-pdf"])("accepts %s", (kind) => {
    expect(GatherOutputKindSchema.safeParse(kind).success).toBe(true);
  });

  it("rejects unknown output implementations", () => {
    expect(GatherOutputKindSchema.safeParse("remote-script").success).toBe(false);
    expect(GatherOutputKindSchema.safeParse(null).success).toBe(false);
  });
});
