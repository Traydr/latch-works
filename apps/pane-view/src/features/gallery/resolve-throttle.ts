/**
 * Client-side guards that prevent the gallery from melting a cold server with a
 * request storm. Hundreds of mounted tiles previously each ran their own
 * unbounded `resolveMediaDeliveryUrl` retry loop, producing
 * `net::ERR_INSUFFICIENT_RESOURCES` and 25s+ first paints.
 *
 * Three mechanisms work together:
 *  - a global concurrency gate caps in-flight resolves,
 *  - exponential backoff with jitter spaces out per-tile retries,
 *  - a circuit breaker pauses new attempts after repeated hard failures.
 */

const MAX_CONCURRENT_RESOLVES = 6;
const BASE_BACKOFF_MS = 800;
const MAX_BACKOFF_MS = 8_000;
const CIRCUIT_FAILURE_THRESHOLD = 8;
const CIRCUIT_COOLDOWN_MS = 10_000;

type Releaser = () => void;

let activeCount = 0;
const waiters: Array<(release: Releaser) => void> = [];

function releaseSlot(): void {
  const next = waiters.shift();
  if (next) {
    // Hand the slot directly to the next waiter without decrementing.
    next(releaseSlot);
    return;
  }

  activeCount = Math.max(0, activeCount - 1);
}

/**
 * Acquires a concurrency slot, resolving with a release callback. Callers must
 * invoke the releaser exactly once when their work settles.
 */
export function acquireResolveSlot(): Promise<Releaser> {
  if (activeCount < MAX_CONCURRENT_RESOLVES) {
    activeCount += 1;
    return Promise.resolve(releaseSlot);
  }

  return new Promise<Releaser>((resolve) => {
    waiters.push(resolve);
  });
}

let consecutiveFailures = 0;
let circuitOpenUntil = 0;

export function isCircuitOpen(now: number = Date.now()): boolean {
  return now < circuitOpenUntil;
}

export function circuitWaitMs(now: number = Date.now()): number {
  return Math.max(0, circuitOpenUntil - now);
}

export function recordResolveSuccess(): void {
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
}

export function recordResolveFailure(now: number = Date.now()): void {
  consecutiveFailures += 1;
  if (consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    circuitOpenUntil = now + CIRCUIT_COOLDOWN_MS;
    consecutiveFailures = 0;
  }
}

/**
 * Exponential backoff with full jitter. `attempt` is zero-based.
 */
export function backoffDelayMs(attempt: number): number {
  const capped = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  return Math.round(Math.random() * capped);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** Test-only reset of module state. */
export function __resetResolveThrottleForTests(): void {
  activeCount = 0;
  waiters.length = 0;
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
}
