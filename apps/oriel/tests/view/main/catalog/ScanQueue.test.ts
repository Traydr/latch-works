import { describe, expect, it } from 'vitest';

import { ScanQueue } from '../../../src/main/catalog/ScanQueue';

/**
 * Stands in for the catalog worker: a started scan runs until it is cancelled or the test ends it,
 * and `waitForScan` resolves once it has.
 */
function createWorker() {
  let endScan: () => void = () => undefined;

  let running = Promise.resolve();
  let cancels = 0;

  return {
    cancelScan: async () => {
      cancels += 1;
      endScan();
    },
    get cancels() {
      return cancels;
    },
    startScan: () => {
      running = new Promise<void>((resolve) => {
        endScan = resolve;
      });
    },
    waitForScan: () => running,
  };
}

/** Lets every queued promise continuation run. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('ScanQueue', () => {
  it('cancels the running scan for a newer request and starts it once that scan ended', async () => {
    const worker = createWorker();
    const queue = new ScanQueue(worker);
    const started: string[] = [];

    const request = (folder: string) =>
      queue.request(async () => {
        started.push(folder);
        worker.startScan();

        return folder;
      }, 'superseded');

    const first = request('/remembered');
    await settle();

    expect(worker.cancels).toBe(0);

    const second = request('/opened');

    expect(queue.isRunningLatest()).toBe(false);

    await settle();

    expect(worker.cancels).toBe(1);
    expect(started).toEqual(['/remembered', '/opened']);
    expect(queue.isRunningLatest()).toBe(true);
    await expect(first).resolves.toBe('/remembered');
    await expect(second).resolves.toBe('/opened');
  });

  it('runs only the newest of the requests that piled up behind a running scan', async () => {
    const worker = createWorker();
    const queue = new ScanQueue(worker);
    const started: string[] = [];
    let holdFirst: () => void = () => undefined;

    // The first request is still setting up (not yet started its scan) while the others arrive.
    const running = queue.request(async (isLatest) => {
      await new Promise<void>((resolve) => {
        holdFirst = resolve;
      });

      if (isLatest()) {
        started.push('/a');
      }

      return '/a';
    }, 'superseded');

    const request = (folder: string) =>
      queue.request(async () => {
        started.push(folder);

        return folder;
      }, 'superseded');

    await settle();

    const dropped = [request('/b'), request('/c')];
    const newest = request('/d');

    await expect(Promise.all(dropped)).resolves.toEqual(['superseded', 'superseded']);

    holdFirst();

    await expect(running).resolves.toBe('/a');
    await expect(newest).resolves.toBe('/d');
    expect(started).toEqual(['/d']);
  });
});
