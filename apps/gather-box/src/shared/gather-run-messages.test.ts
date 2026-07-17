import { describe, expect, it } from "vitest";
import {
  isGatherRunEvent,
  isGatherRunEventMessage,
  GATHER_RUN_EVENT
} from "./gather-run-messages";

describe("Gather Run event validation", () => {
  it("accepts known event kinds with required fields", () => {
    expect(isGatherRunEvent({ kind: "permission-required" })).toBe(true);
    expect(
      isGatherRunEvent({
        kind: "writing",
        destinationPreview: "Archive/a",
        folderSegments: ["a"],
        total: 2
      })
    ).toBe(true);
    expect(
      isGatherRunEvent({ kind: "progress", completed: 1, total: 2, message: "Working" })
    ).toBe(true);
    expect(isGatherRunEvent({ kind: "log", message: "hi", tone: "success" })).toBe(true);
    expect(
      isGatherRunEvent({
        kind: "complete",
        saved: 1,
        skipped: 0,
        failed: 0,
        failedItems: [],
        retryImages: []
      })
    ).toBe(true);
    expect(isGatherRunEvent({ kind: "failed", message: "nope" })).toBe(true);
    expect(isGatherRunEvent({ kind: "cancelled" })).toBe(true);
  });

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
