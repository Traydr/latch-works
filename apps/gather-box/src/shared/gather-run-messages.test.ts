import { describe, expect, it } from "vitest";
import {
  isGatherRunEvent,
  isGatherRunEventMessage,
  GATHER_RUN_EVENT
} from "./gather-run-messages";

describe("Gather Run event validation", () => {
  it("rejects unknown kinds and incomplete payloads", () => {
    expect(isGatherRunEvent({ kind: "explode" })).toBe(false);
    expect(isGatherRunEvent({ kind: "writing", destinationPreview: "x", total: 1 })).toBe(false);
    expect(isGatherRunEvent({ kind: "failed" })).toBe(false);
    expect(
      isGatherRunEventMessage({
        type: GATHER_RUN_EVENT,
        target: "background",
        runId: "run-1",
        event: { kind: "complete", saved: 1 }
      })
    ).toBe(false);
  });
});
