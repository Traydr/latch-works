import { setTimeout as delay } from 'node:timers/promises';

export async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 10,
): Promise<void> {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Condition was not met within ${timeoutMs}ms`);
    }

    await delay(intervalMs);
  }
}
