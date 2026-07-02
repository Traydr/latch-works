import { describe, expect, it } from "vitest";

import {
  isElapsedClockActive,
  shouldEndRunOnComplete,
} from "../../src/renderer/lib/run-lifecycle";

describe("shouldEndRunOnComplete", () => {
  it("ends standalone plan runs", () => {
    expect(shouldEndRunOnComplete("plan", "plan")).toBe(true);
  });

  it("ignores nested plan completion during push", () => {
    expect(shouldEndRunOnComplete("plan", "push")).toBe(false);
  });

  it("ignores nested plan completion during prune", () => {
    expect(shouldEndRunOnComplete("plan", "prune")).toBe(false);
  });

  it("ends push completion during push", () => {
    expect(shouldEndRunOnComplete("push", "push")).toBe(true);
  });
});

describe("isElapsedClockActive", () => {
  it("ticks while running", () => {
    expect(isElapsedClockActive(true, 100, null)).toBe(true);
    expect(isElapsedClockActive(true, 100, 200)).toBe(true);
  });

  it("ticks after a run started until endedAt is set", () => {
    expect(isElapsedClockActive(false, 100, null)).toBe(true);
    expect(isElapsedClockActive(false, 100, 200)).toBe(false);
  });

  it("is idle without a started run", () => {
    expect(isElapsedClockActive(false, null, null)).toBe(false);
  });
});
