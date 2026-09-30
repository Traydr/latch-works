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

const permissionRequired: GatherRunEvent = { kind: "permission-required", scope: "site" };

const cancelled: GatherRunEvent = { kind: "cancelled", message: "Gather Run cancelled." };

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

  it("keeps redelivering a terminal report past the backoff until the background accepts it", async () => {
    const delays: number[] = [];
    let attempts = 0;

    const emitter = createGatherRunEventEmitter(
      async () => {
        attempts += 1;

        return attempts === 20;
      },
      async (milliseconds) => {
        delays.push(milliseconds);
      }
    );

    await emitter.emit(complete);
    emitter.flush();

    await expect.poll(() => attempts).toBe(20);
    expect(Math.max(...delays)).toBe(30_000);
  });

  it("holds a permission pause until the slot is released, then redelivers it", async () => {
    const attempts: GatherRunEvent[] = [];

    const emitter = createGatherRunEventEmitter(
      async (event) => {
        attempts.push(event);

        return attempts.length === 2;
      },
      async () => undefined
    );

    await emitter.emit(permissionRequired);
    expect(attempts).toEqual([]);

    emitter.flush();

    await expect.poll(() => attempts.length).toBe(2);
    expect(attempts).toEqual([permissionRequired, permissionRequired]);
  });

  it("reports a cancellation instead of a permission pause it followed", async () => {
    const attempts: GatherRunEvent[] = [];

    const emitter = createGatherRunEventEmitter(async (event) => {
      attempts.push(event);

      return true;
    });

    await emitter.emit(permissionRequired);
    await emitter.emit(cancelled);
    emitter.flush();

    await expect.poll(() => attempts).toEqual([cancelled]);
  });

  it("stops redelivering once a newer execution of the run reports for it", async () => {
    let attempts = 0;
    let releaseWait: () => void = () => undefined;

    const emitter = createGatherRunEventEmitter(
      async () => {
        attempts += 1;

        return false;
      },
      () =>
        new Promise<void>((resolve) => {
          releaseWait = resolve;
        })
    );

    await emitter.emit(complete);
    emitter.flush();
    await expect.poll(() => attempts).toBe(1);

    emitter.stop();
    releaseWait();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(attempts).toBe(1);
  });
});
