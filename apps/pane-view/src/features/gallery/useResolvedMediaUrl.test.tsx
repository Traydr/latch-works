// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createResolvedMediaUrlCache,
  type ResolvedMediaUrlCache,
  useResolvedMediaUrl,
} from "./useResolvedMediaUrl";

const mocks = vi.hoisted(() => ({
  resolveMediaDeliveryUrl: vi.fn(),
}));

vi.mock("@/features/media/media-delivery-service", () => ({
  resolveMediaDeliveryUrl: mocks.resolveMediaDeliveryUrl,
}));

function renderHookPair(cache: ResolvedMediaUrlCache): { unmount: () => void } {
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

function renderSingleHook(cache: ResolvedMediaUrlCache): {
  getState: () => ReturnType<typeof useResolvedMediaUrl> | undefined;
  unmount: () => void;
} {
  let root: Root | undefined;
  let state: ReturnType<typeof useResolvedMediaUrl> | undefined;
  const container = document.createElement("div");

  function Host(): ReactNode {
    state = useResolvedMediaUrl({
      cache,
      mediaId: "00000000-0000-4000-8000-000000000002",
      size: 720,
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
    cache = createResolvedMediaUrlCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("shares an in-flight pending resolve across matching mounted consumers", async () => {
    mocks.resolveMediaDeliveryUrl.mockResolvedValue({ pending: true });
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
    await createResolvedMediaUrlCache().resolve(input);

    expect(mocks.resolveMediaDeliveryUrl).toHaveBeenCalledTimes(2);
  });
});
