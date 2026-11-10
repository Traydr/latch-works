export type SerialQueue = <T>(task: () => Promise<T>) => Promise<T>;

/** Runs tasks one at a time in call order; a task that fails does not stop the ones after it. */
export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();

  return (task) => {
    const result = tail.then(task, task);
    tail = result.catch(() => undefined);

    return result;
  };
}
