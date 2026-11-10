import { abortError, throwIfAborted, toError } from "./errors.js";

export interface QueueControl<T> {
  /** Queues another task; throws once the run is aborted. */
  add(task: T): void;
  /** False once a task failed or the run was aborted; work still in flight should stop. */
  running(): boolean;
}

/**
 * Runs `work` over `tasks`, at most `concurrency` at once; tasks may queue more as they run. A
 * failed task or an abort stops new tasks from starting, and the queue settles only once the tasks
 * in flight have finished, rejecting with the first failure or the abort reason.
 */
export async function runQueue<T>({
  concurrency,
  signal,
  tasks,
  work,
}: {
  concurrency: number;
  signal?: AbortSignal;
  tasks: T[];
  work: (task: T, control: QueueControl<T>) => Promise<void>;
}): Promise<void> {
  let next = 0;
  let active = 0;
  let firstError: Error | undefined;

  const running = () => firstError === undefined && !signal?.aborted;

  const control: QueueControl<T> = {
    add(task) {
      throwIfAborted(signal);
      tasks.push(task);
    },
    running,
  };

  await new Promise<void>((resolve, reject) => {
    const settleIfDone = (): void => {
      if (active > 0 || (running() && next < tasks.length)) {
        return;
      }

      if (firstError) {
        reject(firstError);
      } else if (signal?.aborted) {
        reject(abortError(signal));
      } else {
        resolve();
      }
    };

    const schedule = (): void => {
      while (running() && active < concurrency && next < tasks.length) {
        const task = tasks[next++];

        if (task === undefined) {
          continue;
        }

        active += 1;
        work(task, control)
          .catch((cause: unknown) => {
            firstError ??= toError(cause);
          })
          .finally(() => {
            active -= 1;
            schedule();
            settleIfDone();
          });
      }

      settleIfDone();
    };

    schedule();
  });
}
