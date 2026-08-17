// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaneViewImage } from "./PaneViewImage";
import {
  IMAGE_LOAD_MAX_ATTEMPTS,
  IMAGE_LOAD_REFRESH_URL_AFTER_FAILURES,
  IMAGE_LOAD_RETRY_DELAYS_MS,
  imageLoadRetryDelayMs,
} from "./useImageLoadRetry";
import {
  createResolvedMediaUrlCache,
  type ResolvedMediaUrlCache,
  type ResolveMediaDeliveryUrl,
} from "./useResolvedMediaUrl";

const MEDIA_ID = "00000000-0000-4000-8000-000000000001";
const READY_URL = "https://media.example.test/thumb.webp";
const FRESH_URL = "https://media.example.test/thumb-fresh.webp";

let root: Root | undefined;
let container: HTMLDivElement;
let cache: ResolvedMediaUrlCache;
let resolveCalls: Parameters<ResolveMediaDeliveryUrl>[0][];

function renderImage(): void {
  act(() => {
    root = createRoot(container);
    root.render(
      createElement(PaneViewImage, {
        alt: "photo",
        cache,
        mediaId: MEDIA_ID,
        readyUrl: READY_URL,
        resolveMissing: false,
        variant: "thumbnail",
        width: 220,
      }),
    );
  });
}

function currentImage(): HTMLImageElement | null {
  return container.querySelector("img");
}

function failCurrentImage(): void {
  const image = currentImage();
  if (!image) {
    throw new Error("expected an <img> to be mounted");
  }
  act(() => {
    image.dispatchEvent(new Event("error"));
  });
}

async function flushResolves(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(1);
  container = document.createElement("div");
  document.body.append(container);
  resolveCalls = [];
  cache = createResolvedMediaUrlCache({
    resolve: async (options) => {
      resolveCalls.push(options);
      return { pending: false, url: FRESH_URL };
    },
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("imageLoadRetryDelayMs", () => {
  it("walks the schedule with jitter and ends with null", () => {
    expect(imageLoadRetryDelayMs(0)).toBeNull();
    expect(imageLoadRetryDelayMs(1, () => 0)).toBe(500);
    expect(imageLoadRetryDelayMs(1, () => 1)).toBe(1_000);
    expect(imageLoadRetryDelayMs(IMAGE_LOAD_RETRY_DELAYS_MS.length, () => 1)).toBe(32_000);
    expect(imageLoadRetryDelayMs(IMAGE_LOAD_MAX_ATTEMPTS)).toBeNull();
  });
});

describe("PaneViewImage", () => {
  it("renders the supplied URL without touching the resolver", async () => {
    renderImage();
    await flushResolves();

    expect(currentImage()?.getAttribute("src")).toBe(READY_URL);
    expect(resolveCalls).toEqual([]);
  });

  it("hides a failed image and remounts it after the backoff", () => {
    renderImage();

    failCurrentImage();
    expect(currentImage()).toBeNull();

    act(() => {
      vi.advanceTimersByTime(IMAGE_LOAD_RETRY_DELAYS_MS[0] - 1);
    });
    expect(currentImage()).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(currentImage()?.getAttribute("src")).toBe(READY_URL);
  });

  it("re-resolves the URL once enough loads have failed", async () => {
    renderImage();

    for (let failure = 1; failure < IMAGE_LOAD_REFRESH_URL_AFTER_FAILURES; failure += 1) {
      failCurrentImage();
      act(() => {
        vi.advanceTimersByTime(IMAGE_LOAD_RETRY_DELAYS_MS[failure - 1] ?? 0);
      });
      expect(currentImage()?.getAttribute("src")).toBe(READY_URL);
    }
    expect(resolveCalls).toEqual([]);

    failCurrentImage();
    await flushResolves();
    expect(resolveCalls).toEqual([
      { data: { mediaId: MEDIA_ID, size: 220, variant: "thumbnail" } },
    ]);

    act(() => {
      vi.advanceTimersByTime(
        IMAGE_LOAD_RETRY_DELAYS_MS[IMAGE_LOAD_REFRESH_URL_AFTER_FAILURES - 1] ?? 0,
      );
    });
    expect(currentImage()?.getAttribute("src")).toBe(FRESH_URL);
  });

  it("settles into the failed state after the whole schedule", async () => {
    renderImage();

    for (const delayMs of IMAGE_LOAD_RETRY_DELAYS_MS) {
      failCurrentImage();
      await flushResolves();
      act(() => {
        vi.advanceTimersByTime(delayMs);
      });
      expect(currentImage()).not.toBeNull();
    }

    failCurrentImage();
    expect(currentImage()).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(currentImage()).toBeNull();
  });
});
