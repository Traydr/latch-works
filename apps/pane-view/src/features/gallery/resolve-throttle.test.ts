import { describe, expect, it } from "vitest";
import { backoffDelayMs, createResolveThrottle } from "./resolve-throttle";

describe("acquireResolveSlot", () => {
  it("caps in-flight resolves at the global concurrency limit", async () => {
    const throttle = createResolveThrottle();
    const max = 6;
    const releasers = await Promise.all(
      Array.from({ length: max }, () => throttle.acquireResolveSlot()),
    );

    let extraGranted = false;
    const extra = throttle.acquireResolveSlot().then((release) => {
      extraGranted = true;
      return release;
    });

    await Promise.resolve();
    expect(extraGranted).toBe(false);

    const [firstRelease, ...remaining] = releasers;
    firstRelease?.();
    const extraRelease = await extra;
    expect(extraGranted).toBe(true);

    extraRelease();
    for (const release of remaining) release();
  });
});

describe("circuit breaker", () => {
  it("opens after repeated failures and a success resets it", () => {
    const throttle = createResolveThrottle();
    expect(throttle.isCircuitOpen()).toBe(false);

    for (let i = 0; i < 8; i += 1) {
      throttle.recordResolveFailure(1_000);
    }

    expect(throttle.isCircuitOpen(1_000)).toBe(true);
    expect(throttle.isCircuitOpen(1_000 + 11_000)).toBe(false);

    throttle.recordResolveSuccess();
    expect(throttle.isCircuitOpen(1_000)).toBe(false);
  });

  it("does not share circuit state between instances", () => {
    const first = createResolveThrottle();
    const second = createResolveThrottle();
    for (let i = 0; i < 8; i += 1) first.recordResolveFailure(1_000);

    expect(first.isCircuitOpen(1_000)).toBe(true);
    expect(second.isCircuitOpen(1_000)).toBe(false);
  });
});

describe("backoffDelayMs", () => {
  it("stays within the jittered exponential ceiling", () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const delay = backoffDelayMs(attempt);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(8_000);
    }
  });
});
