import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ThumbnailBrokerService,
  type ThumbnailChildProcessLike,
} from '../../../src/main/thumbnail/ThumbnailBrokerService';
import type { ThumbnailWorkerRequest } from '../../../src/shared/thumbnail';
import { waitForCondition } from '../../testUtils';

vi.mock('electron', () => ({
  utilityProcess: {
    fork: vi.fn(),
  },
}));

class FakeThumbnailChild extends EventEmitter implements ThumbnailChildProcessLike {
  public killed = false;
  public readonly postedMessages: ThumbnailWorkerRequest[] = [];

  kill(): boolean {
    this.killed = true;
    return true;
  }

  postMessage(message: ThumbnailWorkerRequest): void {
    this.postedMessages.push(message);
  }
}

class CountingAbortSignal extends EventTarget {
  public aborted = false;
  public addCount = 0;
  public removeCount = 0;

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    this.addCount += 1;
    super.addEventListener(type, callback, options);
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    this.removeCount += 1;
    super.removeEventListener(type, callback, options);
  }

  abort(): void {
    this.aborted = true;
    this.dispatchEvent(new Event('abort'));
  }
}

function getGenerateMessages(child: FakeThumbnailChild): ThumbnailWorkerRequest[] {
  return child.postedMessages.filter((message) => message.type === 'generate-thumbnail');
}

describe('ThumbnailBrokerService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dedupes concurrent requests for the same cache key', async () => {
    const children: FakeThumbnailChild[] = [];
    const childFactory = vi.fn((modulePath: string, args: string[]) => {
      void modulePath;
      void args;
      const child = new FakeThumbnailChild();
      children.push(child);
      return child;
    });

    const broker = new ThumbnailBrokerService('C:\\frame-view-user', {
      childFactory,
      imageWorkers: 1,
      videoWorkers: 1,
      workerModulePath: __filename,
    });

    const firstPromise = broker.getThumbnail({
      cacheKey: 'same-key',
      kind: 'image',
      mediaPath: 'C:\\gallery\\one.png',
      priority: 1,
      thumbSize: 220,
    });
    const secondPromise = broker.getThumbnail({
      cacheKey: 'same-key',
      kind: 'image',
      mediaPath: 'C:\\gallery\\one.png',
      priority: 2,
      thumbSize: 220,
    });

    await waitForCondition(
      () => children.length === 1 && getGenerateMessages(children[0]).length === 1,
    );
    const firstChild = children[0];
    expect(firstChild).toBeDefined();
    expect(getGenerateMessages(firstChild as FakeThumbnailChild)).toHaveLength(1);

    const requestId = getGenerateMessages(firstChild as FakeThumbnailChild)[0]?.requestId;
    firstChild?.emit('message', {
      requestId,
      ok: true,
      result: {
        bytes: new Uint8Array([1, 2, 3]),
        cacheCreated: true,
        cacheKey: 'same-key',
        contentType: 'image/webp',
      },
    });

    await expect(firstPromise).resolves.toMatchObject({ bytes: new Uint8Array([1, 2, 3]) });
    await expect(secondPromise).resolves.toMatchObject({ bytes: new Uint8Array([1, 2, 3]) });
  });

  it('prioritizes higher-priority queued requests ahead of stale work', async () => {
    const child = new FakeThumbnailChild();
    const broker = new ThumbnailBrokerService('C:\\frame-view-user', {
      childFactory: () => child,
      imageWorkers: 1,
      videoWorkers: 1,
      workerModulePath: __filename,
    });

    const firstPromise = broker.getThumbnail({
      cacheKey: 'first',
      kind: 'image',
      mediaPath: 'C:\\gallery\\first.png',
      priority: 1,
      thumbSize: 220,
    });

    await waitForCondition(() => getGenerateMessages(child).length === 1);

    const secondPromise = broker.getThumbnail({
      cacheKey: 'second',
      kind: 'image',
      mediaPath: 'C:\\gallery\\second.png',
      priority: 0,
      thumbSize: 220,
    });
    const thirdPromise = broker.getThumbnail({
      cacheKey: 'third',
      kind: 'image',
      mediaPath: 'C:\\gallery\\third.png',
      priority: 2,
      thumbSize: 220,
    });

    const firstRequestId = getGenerateMessages(child)[0]?.requestId;
    child.emit('message', {
      requestId: firstRequestId,
      ok: true,
      result: {
        bytes: new Uint8Array([1]),
        cacheCreated: true,
        cacheKey: 'first',
        contentType: 'image/webp',
      },
    });

    await waitForCondition(() => getGenerateMessages(child).length >= 2);
    expect(getGenerateMessages(child)[1]).toMatchObject({
      job: expect.objectContaining({
        cacheKey: 'third',
        priority: 2,
      }),
    });

    child.emit('message', {
      requestId: getGenerateMessages(child)[1]?.requestId,
      ok: true,
      result: {
        bytes: new Uint8Array([2]),
        cacheCreated: true,
        cacheKey: 'third',
        contentType: 'image/webp',
      },
    });

    await waitForCondition(() => getGenerateMessages(child).length >= 3);
    expect(getGenerateMessages(child)[2]).toMatchObject({
      job: expect.objectContaining({
        cacheKey: 'second',
        priority: 0,
      }),
    });

    child.emit('message', {
      requestId: getGenerateMessages(child)[2]?.requestId,
      ok: true,
      result: {
        bytes: new Uint8Array([3]),
        cacheCreated: true,
        cacheKey: 'second',
        contentType: 'image/webp',
      },
    });

    await Promise.all([firstPromise, secondPromise, thirdPromise]);
  });

  it('prioritizes newer queued requests within the same priority', async () => {
    const child = new FakeThumbnailChild();
    const broker = new ThumbnailBrokerService('C:\\frame-view-user', {
      childFactory: () => child,
      imageWorkers: 1,
      videoWorkers: 1,
      workerModulePath: __filename,
    });

    const firstPromise = broker.getThumbnail({
      cacheKey: 'active',
      kind: 'image',
      mediaPath: 'C:\\gallery\\active.png',
      priority: 1,
      thumbSize: 220,
    });

    await waitForCondition(() => getGenerateMessages(child).length === 1);

    const olderPromise = broker.getThumbnail({
      cacheKey: 'older',
      kind: 'image',
      mediaPath: 'C:\\gallery\\older.png',
      priority: 1,
      thumbSize: 220,
    });
    const newerPromise = broker.getThumbnail({
      cacheKey: 'newer',
      kind: 'image',
      mediaPath: 'C:\\gallery\\newer.png',
      priority: 1,
      thumbSize: 220,
    });

    child.emit('message', {
      requestId: getGenerateMessages(child)[0]?.requestId,
      ok: true,
      result: {
        bytes: new Uint8Array([1]),
        cacheCreated: true,
        cacheKey: 'active',
        contentType: 'image/webp',
      },
    });

    await waitForCondition(() => getGenerateMessages(child).length >= 2);
    expect(getGenerateMessages(child)[1]).toMatchObject({
      job: expect.objectContaining({ cacheKey: 'newer' }),
    });

    child.emit('message', {
      requestId: getGenerateMessages(child)[1]?.requestId,
      ok: true,
      result: {
        bytes: new Uint8Array([2]),
        cacheCreated: true,
        cacheKey: 'newer',
        contentType: 'image/webp',
      },
    });

    await waitForCondition(() => getGenerateMessages(child).length >= 3);
    expect(getGenerateMessages(child)[2]).toMatchObject({
      job: expect.objectContaining({ cacheKey: 'older' }),
    });

    child.emit('message', {
      requestId: getGenerateMessages(child)[2]?.requestId,
      ok: true,
      result: {
        bytes: new Uint8Array([3]),
        cacheCreated: true,
        cacheKey: 'older',
        contentType: 'image/webp',
      },
    });

    await Promise.all([firstPromise, olderPromise, newerPromise]);
  });

  it('removes the transient abort listener after a signalled request resolves', async () => {
    const child = new FakeThumbnailChild();
    const broker = new ThumbnailBrokerService('C:\\frame-view-user', {
      childFactory: () => child,
      imageWorkers: 1,
      videoWorkers: 1,
      workerModulePath: __filename,
    });
    const signal = new CountingAbortSignal();

    const requestPromise = broker.getThumbnail(
      {
        cacheKey: 'abort-listener-cleanup',
        kind: 'image',
        mediaPath: 'C:\\gallery\\cleanup.png',
        priority: 1,
        thumbSize: 220,
      },
      signal as AbortSignal,
    );

    await waitForCondition(() => getGenerateMessages(child).length === 1);
    child.emit('message', {
      requestId: getGenerateMessages(child)[0]?.requestId,
      ok: true,
      result: {
        bytes: new Uint8Array([1]),
        cacheCreated: true,
        cacheKey: 'abort-listener-cleanup',
        contentType: 'image/webp',
      },
    });

    await expect(requestPromise).resolves.toMatchObject({ bytes: new Uint8Array([1]) });
    expect(signal.addCount).toBe(2);
    expect(signal.removeCount).toBe(2);
  });

  it('cancels an active video request when all consumers abort', async () => {
    const child = new FakeThumbnailChild();
    const broker = new ThumbnailBrokerService('C:\\frame-view-user', {
      childFactory: () => child,
      imageWorkers: 1,
      videoWorkers: 1,
      workerModulePath: __filename,
    });

    const abortController = new AbortController();
    const requestPromise = broker.getThumbnail(
      {
        cacheKey: 'video',
        kind: 'video',
        mediaPath: 'C:\\gallery\\clip.mp4',
        priority: 2,
        thumbSize: 220,
      },
      abortController.signal,
    );

    await waitForCondition(() => getGenerateMessages(child).length === 1);
    const requestId = getGenerateMessages(child)[0]?.requestId;
    abortController.abort();

    await expect(requestPromise).rejects.toMatchObject({
      name: 'AbortError',
    });
    await waitForCondition(() =>
      child.postedMessages.some(
        (message) => message.type === 'cancel-thumbnail' && message.requestId === requestId,
      ),
    );
  });

  it('keeps a coalesced active request alive while one consumer remains', async () => {
    const child = new FakeThumbnailChild();
    const broker = new ThumbnailBrokerService('C:\\frame-view-user', {
      childFactory: () => child,
      imageWorkers: 1,
      videoWorkers: 1,
      workerModulePath: __filename,
    });

    const firstAbort = new AbortController();
    const firstPromise = broker.getThumbnail(
      {
        cacheKey: 'shared',
        kind: 'video',
        mediaPath: 'C:\\gallery\\shared.mp4',
        priority: 2,
        thumbSize: 220,
      },
      firstAbort.signal,
    );
    const secondPromise = broker.getThumbnail({
      cacheKey: 'shared',
      kind: 'video',
      mediaPath: 'C:\\gallery\\shared.mp4',
      priority: 2,
      thumbSize: 220,
    });

    await waitForCondition(() => getGenerateMessages(child).length === 1);
    const requestId = getGenerateMessages(child)[0]?.requestId;
    firstAbort.abort();

    await expect(firstPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(
      child.postedMessages.some(
        (message) => message.type === 'cancel-thumbnail' && message.requestId === requestId,
      ),
    ).toBe(false);

    child.emit('message', {
      requestId,
      ok: true,
      result: {
        bytes: new Uint8Array([8]),
        cacheCreated: true,
        cacheKey: 'shared',
        contentType: 'image/webp',
      },
    });

    await expect(secondPromise).resolves.toMatchObject({ bytes: new Uint8Array([8]) });
  });

  it('ignores a late stale response after cancel so a newer job stays active', async () => {
    const child = new FakeThumbnailChild();
    const broker = new ThumbnailBrokerService('C:\\frame-view-user', {
      childFactory: () => child,
      imageWorkers: 1,
      videoWorkers: 1,
      workerModulePath: __filename,
    });

    const firstAbort = new AbortController();
    const firstPromise = broker.getThumbnail(
      {
        cacheKey: 'stale',
        kind: 'image',
        mediaPath: 'C:\\gallery\\stale.png',
        priority: 1,
        thumbSize: 220,
      },
      firstAbort.signal,
    );

    await waitForCondition(() => getGenerateMessages(child).length === 1);
    const staleRequestId = getGenerateMessages(child)[0]?.requestId;
    firstAbort.abort();
    await expect(firstPromise).rejects.toMatchObject({ name: 'AbortError' });

    const secondPromise = broker.getThumbnail({
      cacheKey: 'fresh',
      kind: 'image',
      mediaPath: 'C:\\gallery\\fresh.png',
      priority: 2,
      thumbSize: 220,
    });

    await waitForCondition(() => getGenerateMessages(child).length === 2);
    const freshRequestId = getGenerateMessages(child)[1]?.requestId;
    expect(freshRequestId).toBeDefined();
    expect(freshRequestId).not.toBe(staleRequestId);

    // Late response for the cancelled request must not clear the fresh active slot.
    child.emit('message', {
      requestId: staleRequestId,
      ok: true,
      result: {
        bytes: new Uint8Array([1]),
        cacheCreated: true,
        cacheKey: 'stale',
        contentType: 'image/webp',
      },
    });

    expect(broker.getStatus().inflightRequests).toBe(1);

    child.emit('message', {
      requestId: freshRequestId,
      ok: true,
      result: {
        bytes: new Uint8Array([2, 2]),
        cacheCreated: true,
        cacheKey: 'fresh',
        contentType: 'image/webp',
      },
    });

    await expect(secondPromise).resolves.toMatchObject({ bytes: new Uint8Array([2, 2]) });
  });

  it('rejects an active request when a worker exits and restarts lazily on the next request', async () => {
    const children: FakeThumbnailChild[] = [];
    const childFactory = vi.fn((modulePath: string, args: string[]) => {
      void modulePath;
      void args;
      const child = new FakeThumbnailChild();
      children.push(child);
      return child;
    });

    const broker = new ThumbnailBrokerService('C:\\frame-view-user', {
      childFactory,
      imageWorkers: 1,
      videoWorkers: 1,
      workerModulePath: __filename,
    });

    const firstPromise = broker.getThumbnail({
      cacheKey: 'restart',
      kind: 'image',
      mediaPath: 'C:\\gallery\\restart.png',
      priority: 1,
      thumbSize: 220,
    });

    await waitForCondition(
      () => children.length === 1 && getGenerateMessages(children[0]).length === 1,
    );
    const firstChild = children[0];
    expect(firstChild).toBeDefined();
    firstChild?.emit('exit', 1);

    await expect(firstPromise).rejects.toThrow('Thumbnail worker exited unexpectedly');

    const secondPromise = broker.getThumbnail({
      cacheKey: 'restart-2',
      kind: 'image',
      mediaPath: 'C:\\gallery\\restart-2.png',
      priority: 2,
      thumbSize: 220,
    });

    await waitForCondition(
      () => children.length === 2 && getGenerateMessages(children[1]).length === 1,
    );
    const secondChild = children[1];
    expect(secondChild).toBeDefined();
    expect(childFactory).toHaveBeenCalledTimes(2);

    secondChild?.emit('message', {
      requestId: getGenerateMessages(secondChild as FakeThumbnailChild)[0]?.requestId,
      ok: true,
      result: {
        bytes: new Uint8Array([9, 9]),
        cacheCreated: true,
        cacheKey: 'restart-2',
        contentType: 'image/webp',
      },
    });

    await expect(secondPromise).resolves.toMatchObject({ bytes: new Uint8Array([9, 9]) });
  });
});
