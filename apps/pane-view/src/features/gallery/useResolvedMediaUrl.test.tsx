// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createResolvedMediaUrlCache,
  type ResolvedMediaUrlCache,
  type ResolveMediaDeliveryUrl,
  useResolvedMediaUrl,
} from "./useResolvedMediaUrl";

const mocks = {
  resolveMediaDeliveryUrl: vi.fn<ResolveMediaDeliveryUrl>(),
};

interface HookHarness {
  unmount: () => void;
}

interface SingleHookHarness extends HookHarness {
  getState: () => ReturnType<typeof useResolvedMediaUrl> | undefined;
}

function renderHookPair(cache: ResolvedMediaUrlCache): HookHarness {
  let root: Root | undefined;
  const container = document.createElement("div");

  function Host(): ReactNode {
    useResolvedMediaUrl({
      cache,
      mediaId: "00000000-0000-4000-8000-000000000001",
      size: 320,
      variant: "thumbnail",
    });
    useResolvedMediaUrl({
      cache,
      mediaId: "00000000-0000-4000-8000-000000000001",
      size: 320,
      variant: "thumbnail",
    });
    return null;
  }

  act(() => {
    root = createRoot(container);
    root.render(createElement(Host));
  });

  return {
    unmount: () => {
      act(() => {
        root?.unmount();
      });
    },
  };
}

function renderSingleHook(
  cache: ResolvedMediaUrlCache,
  options: { mediaId?: string; refreshKey?: number; size?: number } = {},
): SingleHookHarness {
  let root: Root | undefined;
  let state: ReturnType<typeof useResolvedMediaUrl> | undefined;
  const container = document.createElement("div");

  function Host(): ReactNode {
    state = useResolvedMediaUrl({
      cache,
      mediaId: options.mediaId ?? "00000000-0000-4000-8000-000000000002",
      refreshKey: options.refreshKey,
      size: options.size ?? 720,
      variant: "thumbnail",
    });
    return null;
  }

  act(() => {
    root = createRoot(container);
    root.render(createElement(Host));
  });

  return {
    getState: () => state,
    unmount: () => {
      act(() => root?.unmount());
    },
  };
}

describe("useResolvedMediaUrl", () => {
  let cache: ResolvedMediaUrlCache;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.resolveMediaDeliveryUrl.mockReset();
    cache = createResolvedMediaUrlCache({ resolve: mocks.resolveMediaDeliveryUrl });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("shares an in-flight pending resolve across matching mounted consumers", async () => {
    mocks.resolveMediaDeliveryUrl.mockResolvedValue({ pending: true, retryAfterMs: 5_000 });
    const { unmount } = renderHookPair(cache);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.resolveMediaDeliveryUrl).toHaveBeenCalledTimes(1);
    expect(mocks.resolveMediaDeliveryUrl).toHaveBeenCalledWith({
      data: {
        mediaId: "00000000-0000-4000-8000-000000000001",
        size: 320,
        variant: "thumbnail",
      },
    });

    unmount();
  });

  it("keeps polling a visible pending rendition until it is ready", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    mocks.resolveMediaDeliveryUrl
      .mockResolvedValueOnce({ pending: true, retryAfterMs: 5_000 })
      .mockResolvedValueOnce({ pending: false, url: "https://edge.shutter.test/ready" });
    const hook = renderSingleHook(cache);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hook.getState()).toMatchObject({ loading: true, resolvedUrl: undefined });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(hook.getState()).toEqual({
      failed: false,
      loading: false,
      resolvedUrl: "https://edge.shutter.test/ready",
    });
    expect(mocks.resolveMediaDeliveryUrl).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it("does not share resolved URLs between cache instances", async () => {
    mocks.resolveMediaDeliveryUrl.mockResolvedValue({
      pending: false,
      url: "https://edge.shutter.test/ready",
    });
    const input = {
      mediaId: "00000000-0000-4000-8000-000000000001",
      size: 320,
      variant: "thumbnail" as const,
    };

    await cache.resolve(input);
    await createResolvedMediaUrlCache({ resolve: mocks.resolveMediaDeliveryUrl }).resolve(input);

    expect(mocks.resolveMediaDeliveryUrl).toHaveBeenCalledTimes(2);
  });

  it("re-resolves a cached URL when asked to refresh", async () => {
    mocks.resolveMediaDeliveryUrl
      .mockResolvedValueOnce({ pending: false, url: "https://edge.shutter.test/stale" })
      .mockResolvedValueOnce({ pending: false, url: "https://edge.shutter.test/fresh" });
    const input = {
      mediaId: "00000000-0000-4000-8000-000000000001",
      size: 320,
      variant: "thumbnail" as const,
    };

    await expect(cache.resolve(input)).resolves.toEqual({
      status: "ready",
      url: "https://edge.shutter.test/stale",
    });
    await expect(cache.resolve(input)).resolves.toEqual({
      status: "ready",
      url: "https://edge.shutter.test/stale",
    });
    await expect(cache.resolve(input, { refresh: true })).resolves.toEqual({
      status: "ready",
      url: "https://edge.shutter.test/fresh",
    });
    await expect(cache.resolve(input)).resolves.toEqual({
      status: "ready",
      url: "https://edge.shutter.test/fresh",
    });
    expect(mocks.resolveMediaDeliveryUrl).toHaveBeenCalledTimes(2);
  });

  it("drops a cached original URL before its presigned lifetime ends", async () => {
    vi.setSystemTime(new Date("2026-08-18T00:00:00.000Z"));
    mocks.resolveMediaDeliveryUrl
      .mockResolvedValueOnce({ pending: false, url: "https://storage.test/original?sig=1" })
      .mockResolvedValueOnce({ pending: false, url: "https://storage.test/original?sig=2" });
    const input = { mediaId: "00000000-0000-4000-8000-000000000001", variant: "original" as const };

    await expect(cache.resolve(input)).resolves.toMatchObject({
      url: "https://storage.test/original?sig=1",
    });
    vi.advanceTimersByTime(30_000);
    await expect(cache.resolve(input)).resolves.toMatchObject({
      url: "https://storage.test/original?sig=1",
    });
    vi.advanceTimersByTime(20_000);
    await expect(cache.resolve(input)).resolves.toMatchObject({
      url: "https://storage.test/original?sig=2",
    });
    expect(mocks.resolveMediaDeliveryUrl).toHaveBeenCalledTimes(2);
  });

  it("bypasses the shared URL cache when the hook mounts with a refresh key", async () => {
    mocks.resolveMediaDeliveryUrl
      .mockResolvedValueOnce({ pending: false, url: "https://edge.shutter.test/stale" })
      .mockResolvedValueOnce({ pending: false, url: "https://edge.shutter.test/fresh" });
    await cache.resolve({
      mediaId: "00000000-0000-4000-8000-000000000001",
      size: 320,
      variant: "thumbnail",
    });

    const hook = renderSingleHook(cache, {
      mediaId: "00000000-0000-4000-8000-000000000001",
      refreshKey: 1,
      size: 320,
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hook.getState()).toEqual({
      failed: false,
      loading: false,
      resolvedUrl: "https://edge.shutter.test/fresh",
    });
    hook.unmount();
  });
});
