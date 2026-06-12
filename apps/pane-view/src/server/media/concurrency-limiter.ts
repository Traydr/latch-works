export function createConcurrencyLimiter(maxConcurrent: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active >= maxConcurrent) {
        await new Promise<void>((resolve) => {
          queue.push(resolve);
        });
      }

      active += 1;
      try {
        return await task();
      } finally {
        active -= 1;
        const next = queue.shift();
        next?.();
      }
    },
  };
}
