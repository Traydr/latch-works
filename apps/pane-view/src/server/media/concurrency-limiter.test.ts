import { describe, expect, it } from "vitest";
import { createConcurrencyLimiter } from "./concurrency-limiter";

describe("createConcurrencyLimiter", () => {
  it("never runs more than its limit, even for a call made as a slot frees", async () => {
    const limiter = createConcurrencyLimiter(2);
    const releases: Array<() => void> = [];
    let running = 0;
    let peak = 0;

    const task = (): Promise<void> => {
      running += 1;
      peak = Math.max(peak, running);

      return new Promise<void>((resolve) => {
        releases.push(() => {
          running -= 1;
          resolve();
        });
      });
    };

    // Two run and one waits; the task promise of the first is kept so a
    // fourth call can land right after its slot frees, before the waiter wakes.
    let firstTask: Promise<void> | undefined;

    const runs = [
      limiter.run(() => {
        firstTask = task();

        return firstTask;
      }),
      limiter.run(task),
      limiter.run(task),
    ];

    const late = firstTask?.then(() => limiter.run(task));

    while (releases.length > 0 || running > 0) {
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    await Promise.all([...runs, late]);

    expect(peak).toBe(2);
  });
});
