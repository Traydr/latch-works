import { describe, expect, it, vi } from "vitest";
import type { GatherRunEvent } from "../shared/gather-run-messages";
import { GatherExecutionSlot, type GatherExecutionStart } from "./execution-slot";
import { createGatherRunEventEmitter } from "./run-event-emitter";

const complete: GatherRunEvent = {
  kind: "complete",
  saved: 1,
  skipped: 0,
  failed: 0,
  failedItems: [],
  retryImages: []
};

describe("createGatherRunEventEmitter", () => {
  it("frees the execution slot before a terminal report can dispatch the next run", async () => {
    const slot = new GatherExecutionSlot();
    let dispatch: GatherExecutionStart | null = null;
    const emitter = createGatherRunEventEmitter(async (event) => {
      if (event.kind !== "complete") {
        return;
      }
      // Stands in for the background: it dispatches the next queued output while handling the
      // terminal event, before answering the offscreen document.
      dispatch = slot.start("second", async () => undefined);
    });

    expect(
      slot.start(
        "first",
        async () => {
          await emitter.emit({ kind: "progress", completed: 1, total: 1, message: "Processed." });
          await emitter.emit(complete);
        },
        emitter.flush
      )
    ).toBe("started");

    await vi.waitFor(() => expect(dispatch).not.toBeNull());
    expect(dispatch).toBe("started");
  });

  it("delivers events in order and reports the first terminal event only", async () => {
    const delivered: GatherRunEvent["kind"][] = [];
    const emitter = createGatherRunEventEmitter(async (event) => {
      delivered.push(event.kind);
    });

    await emitter.emit({ kind: "writing", destinationPreview: "a", folderSegments: [], total: 1 });
    await emitter.emit({ kind: "progress", completed: 1, total: 1, message: "Processed." });
    await emitter.emit(complete);
    await emitter.emit({ kind: "cancelled", message: "Gather Run cancelled." });
    expect(delivered).toEqual(["writing", "progress"]);

    emitter.flush();
    await vi.waitFor(() => expect(delivered).toEqual(["writing", "progress", "complete"]));

    emitter.flush();
    await Promise.resolve();
    expect(delivered).toEqual(["writing", "progress", "complete"]);
  });

  it("keeps reporting a run that fails to deliver an earlier event", async () => {
    const delivered: GatherRunEvent["kind"][] = [];
    const emitter = createGatherRunEventEmitter(async (event) => {
      if (event.kind === "progress") {
        throw new Error("The receiving end does not exist.");
      }
      delivered.push(event.kind);
    });

    await expect(
      emitter.emit({ kind: "progress", completed: 1, total: 1, message: "Processed." })
    ).rejects.toThrow(/receiving end/);
    await emitter.emit(complete);
    emitter.flush();

    await vi.waitFor(() => expect(delivered).toEqual(["complete"]));
  });
});
