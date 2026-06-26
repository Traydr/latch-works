# Gallery Performance Audit

## Summary

The gallery client already has the hard performance work in place: row virtualization, batched thumbnail resolve, embedded listing URLs, server-side cursor pagination, and viewer resolve throttling. Remaining slowness is primarily **missing pre-generated image derivatives** (addressed in PR #40) and a **pending thumbnail re-poll gap** for videos (addressed in this PR).

## What is already solid

| Layer | Mechanism | Location |
| --- | --- | --- |
| Grid rendering | Row-window virtualization with 3-row overscan | `useVirtualGridMetrics.ts` |
| Thumbnail resolve | Batched server-fn calls (max 48, 200ms debounce) | `batched-thumbnail-resolver.ts` |
| Listing data | Embedded `thumbnailUrl` / `thumbnailDeliveryToken` in cursor pages | `repository.ts` |
| Pagination | Server-side sort/filter, 60 items per page | `gallery-listing.ts` |
| Viewer | Concurrency throttle + circuit breaker | `resolve-throttle.ts` |

## Remaining bottlenecks

| Layer | Issue | Impact | Status |
| --- | --- | --- | --- |
| Gallery client | No re-poll for pending batch items in visible window | Video thumbs stay gray until scroll | **Fixed in this PR** |
| Delivery | Bunny cold-cache miss chains 3 hops | First-view image latency | **PR #40** (pre-generated derivatives) |
| Optimizer | Image derivatives were disabled in production | Cold/pending image tiles | **PR #40** |
| Gallery client | 48-item batch cap | Fast scroll through cold library queues slowly | Future |
| Gallery client | `GalleryPage.tsx` monolith (~1570 lines) | Maintenance risk | Plan 016 |
| Data API | 60 parallel CDN URL signs per listing page | Server CPU on listing | Future |
| Comic mode | Client loads up to 500 items | Large archives slow | Future |

## Fix in this PR

Add **visible-window pending re-poll** in `GalleryPage.tsx`:

1. After each batch resolve, read the earliest `nextRetryAt` among pending visible items.
2. Schedule a `setTimeout` aligned to that delay.
3. Re-issue batch resolve when the timer fires; repeat until no pending items remain.
4. Clear timers on unmount or window change.

This closes the gap where video thumbnails (and image derivatives during backfill) stayed gray until the user scrolled.

## Recommendation

- Land **PR #40** (image derivatives) for the largest image-loading win.
- Monitor optimizer throughput after image prewarm is re-enabled.
- Consider progressive batch drain (>48 unresolved IDs) and `GalleryPage` split as follow-ups.
