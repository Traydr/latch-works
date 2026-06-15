import { afterEach, describe, expect, it } from "vitest";
import {
  __resetResolveThrottleForTests,
  acquireResolveSlot,
  backoffDelayMs,
  isCircuitOpen,
  recordResolveFailure,
  recordResolveSuccess,
} from "./resolve-throttle";

afterEach(() => {
  __resetResolveThrottleForTests();
});

describe("acquireResolveSlot", () => {
  it("caps in-flight resolves at the global concurrency limit", async () => {
    const max = 6;
    const releasers = await Promise.all(Array.from({ length: max }, () => acquireResolveSlot()));

    let extraGranted = false;
    const extra = acquireResolveSlot().then((release) => {
      extraGranted = true;
      return release;
    });

    await Promise.resolve();
    expect(extraGranted).toBe(false);

    // Releasing one slot hands it to the queued waiter.
    const [firstRelease, ...remaining] = releasers;
    firstRelease?.();
    const extraRelease = await extra;
    expect(extraGranted).toBe(true);

    extraRelease();
    for (const release of remaining) {
      release();
    }
  });
});

describe("circuit breaker", () => {
  it("opens after repeated failures and a success resets it", () => {
    expect(isCircuitOpen()).toBe(false);

    for (let i = 0; i < 8; i += 1) {
      recordResolveFailure(1_000);
    }

    expect(isCircuitOpen(1_000)).toBe(true);
    expect(isCircuitOpen(1_000 + 11_000)).toBe(false);

    recordResolveSuccess();
    expect(isCircuitOpen(1_000)).toBe(false);
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
