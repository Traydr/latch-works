// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaDeliveryBatchResult } from "@/features/media/media-delivery-service";
import {
  createThumbnailResolver,
  type GalleryThumbnailResolver,
  type ResolveMediaDeliveryUrls,
} from "./batched-thumbnail-resolver";
import type { GalleryBrowseEntry } from "./gallery-browse-entry";
import { mediaItem } from "./gallery-session-harness";
import {
  useWindowedThumbnailResolution,
  type WindowedListing,
} from "./useWindowedThumbnailResolution";

/**
 * Drives the real resolver over a fake delivery call, so the cache, the
 * eligibility rules, and the retry backoff under test are the production ones.
 * Only the network boundary is scripted.
 */
function scriptedDelivery(
  outcome: (mediaId: string) => "ready" | "pending" | "failed",
  pendingRetryAfterMs = 0,
) {
  const calls: string[][] = [];
  const resolveUrls: ResolveMediaDeliveryUrls = ({ data }) => {
    calls.push(data.items.map((item) => item.mediaId));
    return Promise.resolve({
      results: data.items.map((item): MediaDeliveryBatchResult => {
        const status = outcome(item.mediaId);
        if (status === "ready") {
          return {
            mediaId: item.mediaId,
            size: item.size,
            status: "ready",
            url: `https://example.test/${item.mediaId}`,
            variant: item.variant,
          };
        }
        if (status === "pending") {
          return {
            mediaId: item.mediaId,
            retryAfterMs: pendingRetryAfterMs,
            size: item.size,
            status: "pending",
            variant: item.variant,
          };
        }
        return { mediaId: item.mediaId, size: item.size, status: "failed", variant: item.variant };
      }),
    });
  };
  return { calls, resolveUrls };
}

interface Harness {
  setContentKey: (next: string | null) => void;
  setEntries: (mediaIds: string[]) => void;
  /** One commit, as `useGalleryBrowse` produces: key and rows move together. */
  setListing: (contentKey: string, mediaIds: string[]) => void;
  unmount: () => void;
  urls: () => Record<string, string>;
}

function entriesFor(mediaIds: string[]): GalleryBrowseEntry[] {
  return mediaIds.map((id) => ({ key: `media:${id}`, kind: "media", media: mediaItem(id) }));
}

function renderHook(resolver: GalleryThumbnailResolver, contentKey: string | null): Harness {
  let currentListing: WindowedListing = { entries: [], key: contentKey };
  let latestUrls: Record<string, string> = {};
  let root: Root | undefined;
  const container = document.createElement("div");

  function Host(): ReactNode {
    latestUrls = useWindowedThumbnailResolution(currentListing, resolver).resolvedThumbnailUrls;
    return null;
  }

  const render = () => {
    act(() => {
      root ??= createRoot(container);
      root.render(createElement(Host));
    });
  };
  render();

  return {
    setContentKey: (next) => {
      currentListing = { ...currentListing, key: next };
      render();
    },
    setEntries: (mediaIds) => {
      currentListing = { ...currentListing, entries: entriesFor(mediaIds) };
      render();
    },
    setListing: (key, mediaIds) => {
      currentListing = { entries: entriesFor(mediaIds), key };
      render();
    },
    unmount: () => act(() => root?.unmount()),
    urls: () => latestUrls,
  };
}

/** Lets queued promise callbacks run without advancing any timer. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useWindowedThumbnailResolution", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("resolves a new listing without waiting for the scroll debounce", async () => {
    const delivery = scriptedDelivery(() => "ready");
    const hook = renderHook(createThumbnailResolver(delivery), "browse-a");

    hook.setEntries(["a1", "a2"]);
    await settle();

    expect(delivery.calls).toEqual([["a1", "a2"]]);
    expect(hook.urls()).toMatchObject({ a1: "https://example.test/a1" });
    hook.unmount();
  });

  it("debounces a window change within the same listing", async () => {
    const delivery = scriptedDelivery(() => "ready");
    const hook = renderHook(createThumbnailResolver(delivery), "browse-a");

    hook.setEntries(["a1"]);
    await settle();
    expect(delivery.calls).toHaveLength(1);

    // Scrolling: same listing, different rows in the window.
    hook.setEntries(["a2"]);
    await settle();
    expect(delivery.calls).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(delivery.calls).toEqual([["a1"], ["a2"]]);
    hook.unmount();
  });

  it("does not resolve the outgoing folder while its listing is still on screen", async () => {
    const delivery = scriptedDelivery(() => "ready");
    const hook = renderHook(createThumbnailResolver(delivery), "browse-a");

    hook.setEntries(["a1"]);
    await settle();
    expect(delivery.calls).toEqual([["a1"]]);

    // Navigating: keepPreviousData still shows folder A's rows, so the hook is
    // handed a null content key until folder B's listing lands.
    hook.setContentKey(null);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(delivery.calls).toEqual([["a1"]]);
    hook.unmount();
  });

  /**
   * Regression: the destination listing must not be treated as a scroll. The
   * defect this replaces let the outgoing folder's window mark the browse as
   * already batched, so the arriving rows waited the full debounce.
   */
  it("resolves the destination listing at once when it lands after the navigation", async () => {
    const delivery = scriptedDelivery(() => "ready");
    const hook = renderHook(createThumbnailResolver(delivery), "browse-a");

    hook.setEntries(["a1"]);
    await settle();

    hook.setContentKey(null);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Folder B's listing arrives: new key and new rows in the same commit,
    // which is how `useGalleryBrowse` derives both from one `firstPage`.
    hook.setListing("browse-b", ["b1"]);
    await settle();

    expect(delivery.calls).toEqual([["a1"], ["b1"]]);
    hook.unmount();
  });

  it("retries a pending rendition on the resolver's backoff", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let attempts = 0;
    const delivery = scriptedDelivery(() => (attempts++ === 0 ? "pending" : "ready"));
    const hook = renderHook(createThumbnailResolver(delivery), "browse-a");

    hook.setEntries(["a1"]);
    await settle();
    expect(delivery.calls).toHaveLength(1);
    expect(hook.urls()).toEqual({});

    // First pending delay is 5s, jittered by the stubbed 0.5 to exactly 5s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(delivery.calls).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(delivery.calls).toEqual([["a1"], ["a1"]]);
    expect(hook.urls()).toMatchObject({ a1: "https://example.test/a1" });
    hook.unmount();
  });

  /**
   * The server's `retryAfterMs` must win when it asks for more patience than
   * the internal backoff would give — the resolver takes the max of the two.
   */
  it("honors a server-driven retryAfterMs over the internal backoff", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let attempts = 0;
    const delivery = scriptedDelivery(() => (attempts++ === 0 ? "pending" : "ready"), 9_000);
    const hook = renderHook(createThumbnailResolver(delivery), "browse-a");

    hook.setEntries(["a1"]);
    await settle();
    expect(delivery.calls).toHaveLength(1);

    // Server says 9s; the internal backoff would have fired at 5s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_999);
    });
    expect(delivery.calls).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(delivery.calls).toEqual([["a1"], ["a1"]]);
    expect(hook.urls()).toMatchObject({ a1: "https://example.test/a1" });
    hook.unmount();
  });

  it("stops asking once a rendition has failed", async () => {
    const delivery = scriptedDelivery(() => "failed");
    const hook = renderHook(createThumbnailResolver(delivery), "browse-a");

    hook.setEntries(["a1"]);
    await settle();
    expect(delivery.calls).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(delivery.calls).toHaveLength(1);
    hook.unmount();
  });
});
