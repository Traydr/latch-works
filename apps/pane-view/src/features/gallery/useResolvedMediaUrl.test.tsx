// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetResolvedMediaUrlCacheForTests, useResolvedMediaUrl } from "./useResolvedMediaUrl";

const mocks = vi.hoisted(() => ({
  resolveMediaDeliveryUrl: vi.fn(),
}));

vi.mock("@/features/media/media-delivery-service", () => ({
  resolveMediaDeliveryUrl: mocks.resolveMediaDeliveryUrl,
}));

function renderHookPair(): { unmount: () => void } {
  let root: Root | undefined;
  const container = document.createElement("div");

  function Host(): ReactNode {
    useResolvedMediaUrl({
      mediaId: "00000000-0000-4000-8000-000000000001",
      size: 320,
      variant: "thumbnail",
    });
    useResolvedMediaUrl({
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

describe("useResolvedMediaUrl", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetResolvedMediaUrlCacheForTests();
    mocks.resolveMediaDeliveryUrl.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares an in-flight pending resolve across matching mounted consumers", async () => {
    mocks.resolveMediaDeliveryUrl.mockResolvedValue({ pending: true });
    const { unmount } = renderHookPair();

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
});
