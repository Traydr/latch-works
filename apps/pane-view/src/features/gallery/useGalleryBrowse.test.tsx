// @vitest-environment jsdom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryGalleryPageSource,
  memorySourceKey,
} from "@/features/gallery/gallery-page-source.memory";
import {
  listingRequest,
  mediaItem,
  renderSession,
  SEED_B,
  type SessionHarness,
  scriptedComics,
  scriptedMedia,
} from "@/features/gallery/gallery-session-harness";
import { galleryListingKeys } from "@/features/library/library-queries";

/**
 * Session accumulation (Plan 052 Step 1): pages append in server order, a
 * refetched page 1 dedupes without reordering, exhaustion is not an error, a
 * stalled cursor is, and every load path shares one in-flight request.
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

const keysOf = (h: SessionHarness) => h.session.entries.map((entry) => entry.key);
const idsOf = (h: SessionHarness) => h.session.media.map((item) => item.id);

describe("useGalleryBrowse session accumulation", () => {
  it("appends a random comic page 2 after the page 1 prefix without touching page 1", async () => {
    const request = listingRequest({
      comicMode: true,
      limit: 3,
      recursive: true,
      sortMode: "random",
    });
    const comics = scriptedComics(8);
    const source = createMemoryGalleryPageSource({ [memorySourceKey(request)]: { comics } });
    harness = await renderSession({ request, source });

    const firstPage = keysOf(harness);
    expect(firstPage).toEqual(comics.slice(0, 3).map((comic) => `comic:${comic.id}`));
    expect(harness.session.page.hasMore).toBe(true);
    expect(idsOf(harness)).toEqual(comics.slice(0, 3).map((comic) => comic.cover.id));

    let result: Awaited<ReturnType<typeof harness.session.loadNextPage>> | undefined;
    await act(async () => {
      result = await harness?.session.loadNextPage();
    });
    await harness.flush();

    expect(result?.appendedEntryKeys).toEqual(
      comics.slice(3, 6).map((comic) => `comic:${comic.id}`),
    );
    expect(keysOf(harness).slice(0, 3)).toEqual(firstPage);
    expect(keysOf(harness)).toEqual(comics.slice(0, 6).map((comic) => `comic:${comic.id}`));
    expect(harness.session.entries.every((entry) => entry.kind === "comic")).toBe(true);
    expect(harness.session.entries[0]).not.toHaveProperty("comic.pages");
  });

  it("dedupes a page-1 refetch whose tail overlaps page 2 without reordering", async () => {
    const request = listingRequest({ limit: 4 });
    const media = scriptedMedia(10);
    const key = memorySourceKey(request);
    const source = createMemoryGalleryPageSource({ [key]: { media } });
    harness = await renderSession({ request, source });
    await act(async () => {
      await harness?.session.loadNextPage();
    });
    await harness.flush();
    expect(idsOf(harness)).toEqual(media.slice(0, 8).map((item) => item.id));

    // m-001 is deleted server-side: page 1 now ends with m-004, the old head of page 2.
    source.script(key, { media: media.filter((item) => item.id !== "m-001") });
    await act(async () => {
      await harness?.queryClient.invalidateQueries({ queryKey: galleryListingKeys.all });
    });
    await harness.flush();

    const expected = media
      .filter((item) => item.id !== "m-001")
      .slice(0, 4)
      .concat(media.slice(4, 8))
      .map((item) => item.id);
    expect(idsOf(harness)).toEqual([...new Set(expected)]);
    expect(new Set(idsOf(harness)).size).toBe(idsOf(harness).length);
    expect(harness.session.page.error).toBeNull();
    // Pagination continues from the last accumulated cursor, not the refetched page 1.
    await act(async () => {
      await harness?.session.loadNextPage();
    });
    await harness.flush();
    expect(idsOf(harness).at(-1)).toBe("m-009");
    expect(harness.session.page.hasMore).toBe(false);
  });

  it("reports a page whose cursor equals the requesting cursor as an error", async () => {
    const request = listingRequest({ limit: 3 });
    const source = createMemoryGalleryPageSource({
      [memorySourceKey(request)]: { media: scriptedMedia(9) },
    });
    harness = await renderSession({ request, source });
    source.stallNextCursor();

    let message = "";
    await act(async () => {
      try {
        await harness?.session.loadNextPage();
      } catch (caught) {
        message = String(caught);
      }
    });
    await harness.flush();
    expect(message).toContain("did not advance");
    expect(harness.session.page.error).not.toBeNull();
    // Retry works: hasMore is unchanged and the next load succeeds.
    expect(harness.session.page.hasMore).toBe(true);
    await act(async () => {
      await harness?.session.loadNextPage();
    });
    await harness.flush();
    expect(harness.session.page.error).toBeNull();
    expect(idsOf(harness)).toHaveLength(6);
  });

  it("treats an empty final page as exhaustion, not an error", async () => {
    const request = listingRequest({ limit: 3 });
    const key = memorySourceKey(request);
    const media = scriptedMedia(4);
    const source = createMemoryGalleryPageSource({ [key]: { media } });
    harness = await renderSession({ request, source });
    expect(harness.session.page.hasMore).toBe(true);

    // The last item was deleted after page 1 loaded.
    source.script(key, { media: media.slice(0, 3) });
    let result: Awaited<ReturnType<typeof harness.session.loadNextPage>> | undefined;
    await act(async () => {
      result = await harness?.session.loadNextPage();
    });
    await harness.flush();
    expect(result).toEqual({ appendedEntryKeys: [], appendedMediaIds: [], exhausted: true });
    expect(harness.session.page.hasMore).toBe(false);
    expect(harness.session.page.error).toBeNull();
  });

  it("clears the prefix and requests page 1 with the new seed on shuffle", async () => {
    const request = listingRequest({ limit: 3, sortMode: "random" });
    const source = createMemoryGalleryPageSource({
      [memorySourceKey(request)]: { media: scriptedMedia(9, "a") },
      [memorySourceKey({ ...request, randomSeed: SEED_B })]: { media: scriptedMedia(9, "b") },
    });
    harness = await renderSession({ request, source });
    await act(async () => {
      await harness?.session.loadNextPage();
    });
    await harness.flush();
    expect(idsOf(harness)).toHaveLength(6);

    await harness.rerender({ request: { ...request, randomSeed: SEED_B } });
    expect(idsOf(harness)).toEqual(["b-000", "b-001", "b-002"]);
    expect(source.calls.page.at(-1)).toMatchObject({ randomSeed: SEED_B });
    expect(source.calls.page.at(-1)?.cursor).toBeUndefined();
    expect(harness.session.page.hasMore).toBe(true);
    // Loading more reuses the new seed.
    await act(async () => {
      await harness?.session.loadNextPage();
    });
    await harness.flush();
    expect(source.calls.page.at(-1)).toMatchObject({ randomSeed: SEED_B });
    expect(idsOf(harness)).toEqual(["b-000", "b-001", "b-002", "b-003", "b-004", "b-005"]);
  });

  it("issues one adapter call when the button, observer, and two loads overlap", async () => {
    const request = listingRequest({ limit: 3 });
    const source = createMemoryGalleryPageSource({
      [memorySourceKey(request)]: { media: scriptedMedia(9) },
    });
    harness = await renderSession({ request, source });
    const before = source.calls.page.length;
    source.hold();

    const promises = [
      harness.session.loadNextPage(),
      harness.session.loadNextPage(),
      harness.session.loadNextPage(),
    ];
    expect(promises[0]).toBe(promises[1]);
    expect(source.calls.page.length).toBe(before + 1);
    expect(harness.session.page.hasMore).toBe(true);

    await act(async () => {
      await source.release();
      await Promise.all(promises);
    });
    await harness.flush();
    expect(source.calls.page.length).toBe(before + 1);
    expect(idsOf(harness)).toHaveLength(6);
  });

  it("drops a page that resolves after the browse changed instead of overwriting the live session", async () => {
    const requestA = listingRequest({ limit: 3, path: "a" });
    const requestB = listingRequest({ limit: 3, path: "b" });
    const source = createMemoryGalleryPageSource({
      [memorySourceKey(requestA)]: { media: scriptedMedia(9, "a") },
      [memorySourceKey(requestB)]: { media: scriptedMedia(9, "b") },
    });
    harness = await renderSession({ request: requestA, source });
    source.hold();
    const stale = harness.session.loadNextPage().then(
      () => "resolved",
      (error: Error) => String(error),
    );
    await harness.flush();
    expect(harness.session.page.loading).toBe(true);

    // Move to browse B while A's page 2 is in flight; B loads its own page 2.
    await harness.rerender({ request: requestB });
    // (The rerender is held too until release; both settle together.)
    await act(async () => {
      await source.release();
    });
    await harness.flush();
    expect(idsOf(harness)).toEqual(["b-000", "b-001", "b-002"]);
    expect(harness.session.page.loading).toBe(false);
    await act(async () => {
      await harness?.session.loadNextPage();
    });
    await harness.flush();
    expect(idsOf(harness)).toEqual(["b-000", "b-001", "b-002", "b-003", "b-004", "b-005"]);

    // A's late result: rejected as stale, and B's pages are intact.
    expect(await stale).toContain("changed while a page was loading");
    await harness.flush();
    expect(idsOf(harness)).toEqual(["b-000", "b-001", "b-002", "b-003", "b-004", "b-005"]);
    expect(harness.session.page.error).toBeNull();
    expect(harness.session.page.hasMore).toBe(true);
    expect(source.calls.page.filter((call) => call.path === "a")).toHaveLength(2);
  });

  it("excludes locally deleted media from the navigable sequence but not from entries", async () => {
    const request = listingRequest({ limit: 5 });
    const media = scriptedMedia(5);
    const source = createMemoryGalleryPageSource({ [memorySourceKey(request)]: { media } });
    harness = await renderSession({ excludedMediaIds: new Set(["m-002"]), request, source });
    expect(idsOf(harness)).toEqual(["m-000", "m-001", "m-003", "m-004"]);
    expect(harness.session.allMedia.map((item) => item.id)).toEqual(media.map((item) => item.id));
    expect(keysOf(harness)).toContain("media:m-002");
  });

  it("carries folder entries from page 1 only and never sorts them into later pages", async () => {
    const request = listingRequest({ limit: 2 });
    const source = createMemoryGalleryPageSource({
      [memorySourceKey(request)]: {
        folders: [{ hasChildren: false, name: "b", path: "photos/b" }],
        media: scriptedMedia(4),
      },
    });
    harness = await renderSession({ request, source });
    expect(keysOf(harness)).toEqual(["folder:photos/b", "media:m-000", "media:m-001"]);
    await act(async () => {
      await harness?.session.loadNextPage();
    });
    await harness.flush();
    expect(keysOf(harness)).toEqual([
      "folder:photos/b",
      "media:m-000",
      "media:m-001",
      "media:m-002",
      "media:m-003",
    ]);
  });
});

describe("useGalleryBrowse end-to-end order (Step 5)", () => {
  const scopes = {
    "comic subtree": listingRequest({ comicMode: true, recursive: true }),
    "image-only recursive": listingRequest({ recursive: true, showVideos: false }),
    "non-recursive folder": listingRequest(),
    "recursive subtree": listingRequest({ recursive: true }),
    search: listingRequest({ path: undefined, query: "hero" }),
    "video-only recursive": listingRequest({ recursive: true, showImages: false }),
  } as const;

  const cases = Object.entries(scopes).flatMap(([label, base]) =>
    [7, 48].flatMap((limit) =>
      ["0123456789abcdef0123456789abcdef", SEED_B].map((randomSeed) => ({
        label,
        limit,
        request: { ...base, limit, randomSeed, sortMode: "random" as const },
      })),
    ),
  );

  it.each(cases)("$label · limit $limit · seed $request.randomSeed", async ({ request }) => {
    // Any fixed server order will do: the session must reproduce it exactly.
    const population = 100;
    const scripted = request.comicMode
      ? { comics: scriptedComics(population, `${request.randomSeed.slice(0, 4)}/c`) }
      : { media: scriptedMedia(population, request.randomSeed.slice(0, 4)) };
    const expectedKeys = request.comicMode
      ? (scripted.comics ?? []).map((comic) => `comic:${comic.id}`)
      : (scripted.media ?? []).map((item) => `media:${item.id}`);
    const source = createMemoryGalleryPageSource({ [memorySourceKey(request)]: scripted });
    harness = await renderSession({ request, source });

    const firstPage = keysOf(harness);
    expect(firstPage).toEqual(expectedKeys.slice(0, request.limit));

    for (let guard = 0; guard < 50 && harness.session.page.hasMore; guard += 1) {
      await act(async () => {
        await harness?.session.loadNextPage();
      });
      await harness.flush();
      expect(keysOf(harness).slice(0, firstPage.length)).toEqual(firstPage);
      if (guard === 1) {
        // A page-1 refetch mid-session changes nothing visible.
        const before = keysOf(harness);
        await act(async () => {
          await harness?.queryClient.invalidateQueries({ queryKey: galleryListingKeys.all });
        });
        await harness.flush();
        expect(keysOf(harness)).toEqual(before);
      }
    }
    expect(keysOf(harness)).toEqual(expectedKeys);
    expect(harness.session.page.hasMore).toBe(false);
  });

  it("keeps a deleted page-1 item out of the sequence and everything else in place", async () => {
    const request = listingRequest({ limit: 4 });
    const media = scriptedMedia(12);
    const key = memorySourceKey(request);
    const source = createMemoryGalleryPageSource({ [key]: { media } });
    harness = await renderSession({ request, source });
    for (let index = 0; index < 2; index += 1) {
      await act(async () => {
        await harness?.session.loadNextPage();
      });
      await harness.flush();
    }
    const before = idsOf(harness);
    expect(before).toHaveLength(12);

    const victim = mediaItem("m-002");
    source.script(key, { media: media.filter((item) => item.id !== victim.id) });
    await harness.rerender({ excludedMediaIds: new Set([victim.id]) });
    await act(async () => {
      await harness?.queryClient.invalidateQueries({ queryKey: galleryListingKeys.all });
    });
    await harness.flush();
    expect(idsOf(harness)).toEqual(before.filter((id) => id !== victim.id));
  });
});
