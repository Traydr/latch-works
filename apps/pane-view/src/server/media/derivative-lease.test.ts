import { describe, expect, it } from "vitest";
import { isDerivativeProcessingLeaseExpired } from "./derivative-lease";

describe("derivative processing lease", () => {
  it("treats fresh processing rows as still leased", () => {
    const updatedAt = new Date("2026-06-12T12:00:00.000Z");
    expect(isDerivativeProcessingLeaseExpired(updatedAt, updatedAt.getTime() + 60_000)).toBe(false);
  });

  it("treats stale processing rows as reclaimable", () => {
    const updatedAt = new Date("2026-06-12T12:00:00.000Z");
    expect(
      isDerivativeProcessingLeaseExpired(updatedAt, updatedAt.getTime() + 11 * 60 * 1000),
    ).toBe(true);
  });
});
