import { describe, expect, it } from "vitest";
import {
  GatherRunEventMessageSchema,
  GatherRunEventSchema,
  GATHER_RUN_EVENT
} from "./gather-run-messages";

describe("Gather Run event validation", () => {
  it("rejects unknown kinds and incomplete payloads", () => {
    expect(GatherRunEventSchema.safeParse({ kind: "explode" }).success).toBe(false);
    expect(
      GatherRunEventSchema.safeParse({ kind: "writing", destinationPreview: "x", total: 1 }).success
    ).toBe(false);
    expect(GatherRunEventSchema.safeParse({ kind: "failed" }).success).toBe(false);
    expect(
      GatherRunEventMessageSchema.safeParse({
        type: GATHER_RUN_EVENT,
        target: "background",
        runId: "run-1",
        event: { kind: "complete", saved: 1 }
      }).success
    ).toBe(false);
  });
});
