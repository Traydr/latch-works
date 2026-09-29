import { describe, expect, it } from "vitest";
import type { GatherRunEvent } from "../shared/gather-run-messages";
import { createGatherRunEventEmitter } from "./run-event-emitter";

const complete: GatherRunEvent = {
  kind: "complete",
  saved: 1,
  skipped: 0,
  failed: 0,
  failedItems: [],
  retryImages: []
};

describe("Gather Run event delivery", () => {
  it("redelivers a terminal report until the background accepts it", async () => {
    const attempts: GatherRunEvent[] = [];
    let accepted = false;

    const emitter = createGatherRunEventEmitter(
      async (event) => {
        attempts.push(event);

        if (attempts.length === 1) {
          throw new Error("Could not establish connection.");
        }

        accepted = attempts.length === 3;

        return accepted;
      },
      async () => undefined
    );

    await emitter.emit(complete);
    emitter.flush();

    await expect.poll(() => accepted).toBe(true);
    expect(attempts).toEqual([complete, complete, complete]);
  });
});
