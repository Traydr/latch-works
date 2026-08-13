import { describe, expect, it, vi } from "vitest";
import { GatherExecutionSlot } from "./execution-slot";

describe("GatherExecutionSlot", () => {
  it("rejects a second run until the active run settles", async () => {
    let finish!: () => void;
    const active = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const slot = new GatherExecutionSlot();

    expect(slot.start("first", () => active)).toBe("started");
    expect(slot.start("first", vi.fn())).toBe("duplicate");
    expect(slot.start("second", vi.fn())).toBe("busy");
    expect(slot.activeRunId).toBe("first");

    finish();
    await vi.waitFor(() => expect(slot.activeRunId).toBeNull());
    expect(slot.start("second", async () => undefined)).toBe("started");
  });

  it("runs the release callback with the slot already free", async () => {
    const slot = new GatherExecutionSlot();
    let runIdAtRelease: string | null = "unset";

    slot.start(
      "first",
      async () => undefined,
      () => {
        runIdAtRelease = slot.activeRunId;
      }
    );

    await vi.waitFor(() => expect(runIdAtRelease).toBeNull());
  });

  it("keeps the slot released when its release callback throws", async () => {
    const slot = new GatherExecutionSlot();

    slot.start(
      "first",
      async () => undefined,
      () => {
        throw new Error("reporting failed");
      }
    );

    await vi.waitFor(() => expect(slot.activeRunId).toBeNull());
    expect(slot.start("second", async () => undefined)).toBe("started");
  });

  it("aborts only the matching active run", async () => {
    const slot = new GatherExecutionSlot();
    let signal: AbortSignal | undefined;
    slot.start("first", async (candidate) => {
      signal = candidate;
      await new Promise<void>(() => undefined);
    });

    expect(slot.abort("second")).toBe(false);
    expect(slot.abort("first")).toBe(true);
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  });

  it("releases the slot when an executor throws before returning a promise", async () => {
    const slot = new GatherExecutionSlot();
    const result = slot.start("first", (() => {
      throw new Error("startup failed");
    }) as (signal: AbortSignal) => Promise<void>);

    expect(result).toBe("started");
    await vi.waitFor(() => expect(slot.activeRunId).toBeNull());
  });
});
