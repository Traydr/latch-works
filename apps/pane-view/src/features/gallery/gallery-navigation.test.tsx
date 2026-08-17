// @vitest-environment jsdom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryGalleryPageSource,
  memorySourceKey,
} from "@/features/gallery/gallery-page-source.memory";
import {
  listingRequest,
  renderSession,
  type SessionHarness,
  scriptedComics,
  scriptedMedia,
} from "@/features/gallery/gallery-session-harness";
import { galleryListingKeys } from "@/features/library/library-queries";

/**
 * Boundary navigation behind the session (Plan 052 Step 3): forward loads
 * before it loops, backward stays put on the first item while more pages
 * exist, a failed load stays and a retry succeeds, and repeated steps during
 * a load issue no second request.
 */

let harness: SessionHarness | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  harness?.unmount();
  harness = null;
  vi.unstubAllGlobals();
});

async function step(fn: () => Promise<string | null>): Promise<string | null> {
  let result: string | null = null;
  await act(async () => {
    result = await fn();
  });
  await harness?.flush();
  return result;
}

describe("stepMedia", () => {
  it("moves within the loaded sequence and loads before it loops at the loaded end", async () => {
    const request = listingRequest({ limit: 3 });
    const source = createMemoryGalleryPageSource({
      [memorySourceKey(request)]: { media: scriptedMedia(5) },
    });
    harness = await renderSession({ request, source });
    const calls = source.calls.page.length;

    expect(
      await step(() => harness?.session.stepMedia("m-000", 1, true) ?? Promise.resolve(null)),
    ).toBe("m-001");
    expect(source.calls.page.length).toBe(calls);

    // At the loaded end with hasMore: one request, land on the first appended item.
    expect(
      await step(() => harness?.session.stepMedia("m-002", 1, true) ?? Promise.resolve(null)),
    ).toBe("m-003");
    expect(source.calls.page.length).toBe(calls + 1);
    expect(harness.session.media.map((item) => item.id)).toHaveLength(5);

    // At the true end: wrap only with loop.
    expect(
      await step(() => harness?.session.stepMedia("m-004", 1, false) ?? Promise.resolve(null)),
    ).toBeNull();
    expect(
      await step(() => harness?.session.stepMedia("m-004", 1, true) ?? Promise.resolve(null)),
    ).toBe("m-000");
    expect(source.calls.page.length).toBe(calls + 1);
  });

  it("stays on the first item backward while more pages exist, and wraps only after the final page", async () => {
    const request = listingRequest({ limit: 3 });
    const source = createMemoryGalleryPageSource({
      [memorySourceKey(request)]: { media: scriptedMedia(5) },
    });
    harness = await renderSession({ request, source });

    expect(
      await step(() => harness?.session.stepMedia("m-000", -1, true) ?? Promise.resolve(null)),
    ).toBeNull();
    expect(
      await step(() => harness?.session.stepMedia("m-001", -1, true) ?? Promise.resolve(null)),
    ).toBe("m-000");

    await step(() => harness?.session.loadNextPage().then(() => null) ?? Promise.resolve(null));
    expect(harness.session.page.hasMore).toBe(false);
    expect(
      await step(() => harness?.session.stepMedia("m-000", -1, false) ?? Promise.resolve(null)),
    ).toBeNull();
    expect(
      await step(() => harness?.session.stepMedia("m-000", -1, true) ?? Promise.resolve(null)),
    ).toBe("m-004");
  });

  it("holds the boundary during a load and issues no second request", async () => {
    const request = listingRequest({ limit: 3 });
    const source = createMemoryGalleryPageSource({
      [memorySourceKey(request)]: { media: scriptedMedia(6) },
    });
    harness = await renderSession({ request, source });
    const calls = source.calls.page.length;
    source.hold();

    const first = harness.session.stepMedia("m-002", 1, true);
    const second = harness.session.stepMedia("m-002", 1, true);
    const third = harness.session.stepMedia("m-002", 1, true);
    expect(source.calls.page.length).toBe(calls + 1);

    let results: (string | null)[] = [];
    await act(async () => {
      await source.release();
      results = await Promise.all([first, second, third]);
    });
    await harness.flush();
    // Every held step resolves to the same first appended item: the caller
    // writes it once and the selection advances exactly one step.
    expect(results).toEqual(["m-003", "m-003", "m-003"]);
    expect(source.calls.page.length).toBe(calls + 1);
  });

  it("stays put when the load fails and advances on retry", async () => {
    const request = listingRequest({ limit: 3 });
    const source = createMemoryGalleryPageSource({
      [memorySourceKey(request)]: { media: scriptedMedia(6) },
    });
    harness = await renderSession({ request, source });
    source.failNextPage(new Error("network"));

    expect(
      await step(() => harness?.session.stepMedia("m-002", 1, true) ?? Promise.resolve(null)),
    ).toBeNull();
    expect(harness.session.page.error).not.toBeNull();
    expect(harness.session.page.hasMore).toBe(true);
    expect(harness.session.media).toHaveLength(3);

    expect(
      await step(() => harness?.session.stepMedia("m-002", 1, true) ?? Promise.resolve(null)),
    ).toBe("m-003");
    expect(harness.session.page.error).toBeNull();
  });

  it("wraps after an exhausted response that appended nothing, and skips excluded media", async () => {
    const request = listingRequest({ limit: 3 });
    const key = memorySourceKey(request);
    const media = scriptedMedia(4);
    const source = createMemoryGalleryPageSource({ [key]: { media } });
    harness = await renderSession({ excludedMediaIds: new Set(["m-001"]), request, source });
    expect(harness.session.media.map((item) => item.id)).toEqual(["m-000", "m-002"]);
    expect(
      await step(() => harness?.session.stepMedia("m-000", 1, true) ?? Promise.resolve(null)),
    ).toBe("m-002");

    source.script(key, { media: media.slice(0, 3) });
    expect(
      await step(() => harness?.session.stepMedia("m-002", 1, true) ?? Promise.resolve(null)),
    ).toBe("m-000");
    expect(harness.session.page.hasMore).toBe(false);
    expect(
      await step(() => harness?.session.stepMedia("m-002", 1, false) ?? Promise.resolve(null)),
    ).toBeNull();
  });

  it("wraps using the sequence as it is after the load, not as it was before", async () => {
    const request = listingRequest({ limit: 3 });
    const key = memorySourceKey(request);
    const media = scriptedMedia(4);
    const source = createMemoryGalleryPageSource({ [key]: { media } });
    harness = await renderSession({ request, source });
    // The last item was deleted, and so was the first: the next load is
    // exhausted and empty; wrapping must land on the current first item.
    source.script(key, { media: media.slice(1, 3) });
    await act(async () => {
      await harness?.queryClient.invalidateQueries({ queryKey: galleryListingKeys.all });
    });
    await harness.flush();
    expect(harness.session.media.map((item) => item.id)).toEqual(["m-001", "m-002"]);
    expect(
      await step(() => harness?.session.stepMedia("m-002", 1, true) ?? Promise.resolve(null)),
    ).toBe("m-001");
    expect(harness.session.page.hasMore).toBe(false);
  });

  it("returns nothing for a step whose page resolves after the browse changed", async () => {
    const requestA = listingRequest({ limit: 3, path: "a" });
    const requestB = listingRequest({ limit: 3, path: "b" });
    const source = createMemoryGalleryPageSource({
      [memorySourceKey(requestA)]: { media: scriptedMedia(9, "a") },
      [memorySourceKey(requestB)]: { media: scriptedMedia(9, "b") },
    });
    harness = await renderSession({ request: requestA, source });
    source.hold();
    const pending = harness.session.stepMedia("a-002", 1, true);
    await harness.rerender({ request: requestB });
    await act(async () => {
      await source.release();
    });
    await harness.flush();
    expect(await pending).toBeNull();
    expect(harness.session.media.map((item) => item.id)).toEqual(["b-000", "b-001", "b-002"]);
  });

  it("moves between comics in comic mode", async () => {
    const request = listingRequest({ comicMode: true, limit: 2, recursive: true });
    const comics = scriptedComics(3);
    const source = createMemoryGalleryPageSource({ [memorySourceKey(request)]: { comics } });
    harness = await renderSession({ request, source });
    const covers = comics.map((comic) => comic.cover.id);
    expect(harness.session.media.map((item) => item.id)).toEqual(covers.slice(0, 2));
    expect(
      await step(
        () => harness?.session.stepMedia(covers[1] as string, 1, true) ?? Promise.resolve(null),
      ),
    ).toBe(covers[2]);
    expect(harness.session.entries.map((entry) => entry.key)).toEqual(
      comics.map((comic) => `comic:${comic.id}`),
    );
  });
});

describe("stepEntry", () => {
  it("steps over folders, media, and pages, loading at the loaded end", async () => {
    const request = listingRequest({ limit: 2 });
    const source = createMemoryGalleryPageSource({
      [memorySourceKey(request)]: {
        folders: [{ hasChildren: false, name: "sub", path: "photos/sub" }],
        media: scriptedMedia(4),
      },
    });
    harness = await renderSession({ request, source });
    expect(
      await step(
        () => harness?.session.stepEntry("folder:photos/sub", 1, false) ?? Promise.resolve(null),
      ),
    ).toBe("media:m-000");
    // Backward at the first entry stays while more pages exist.
    expect(
      await step(
        () => harness?.session.stepEntry("folder:photos/sub", -1, true) ?? Promise.resolve(null),
      ),
    ).toBeNull();
    expect(
      await step(
        () => harness?.session.stepEntry("media:m-001", 1, false) ?? Promise.resolve(null),
      ),
    ).toBe("media:m-002");
    expect(harness.session.page.hasMore).toBe(false);
    expect(
      await step(() => harness?.session.stepEntry("media:m-003", 1, true) ?? Promise.resolve(null)),
    ).toBe("folder:photos/sub");
    expect(
      await step(
        () => harness?.session.stepEntry("folder:photos/sub", -1, true) ?? Promise.resolve(null),
      ),
    ).toBe("media:m-003");
  });
});
