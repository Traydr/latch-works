import { describe, expect, it } from "vitest";
import { createConcurrencyLimiter } from "./concurrency-limiter";

describe("createConcurrencyLimiter", () => {
  it("limits concurrent work to the configured maximum", async () => {
    const limiter = createConcurrencyLimiter(1);
    let active = 0;
    let maxActive = 0;

    await Promise.all(
      Array.from({ length: 3 }, () =>
        limiter.run(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
        }),
      ),
    );

    expect(maxActive).toBe(1);
  });
});
