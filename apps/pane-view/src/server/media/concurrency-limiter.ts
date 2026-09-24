export function createConcurrencyLimiter(maxConcurrent: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active >= maxConcurrent) {
        // The slot is handed over by the call that frees it, still counted
        // as active, so a call arriving before this one wakes cannot take it.
        await new Promise<void>((resolve) => {
          queue.push(resolve);
        });
      } else {
        active += 1;
      }

      try {
        return await task();
      } finally {
        const next = queue.shift();

        if (next) {
          next();
        } else {
          active -= 1;
        }
      }
    },
  };
}
