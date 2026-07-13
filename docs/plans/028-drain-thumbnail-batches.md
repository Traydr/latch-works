# Plan 028: Drain every visible thumbnail request in bounded batches

> **Executor instructions**: Preserve the 48-item server contract and existing retry backoff. Run
> every gate and update the plan index when complete.
>
> **Drift check (run first)**: `git diff --stat fd5693d..HEAD -- apps/pane-view/src/features/gallery/batched-thumbnail-resolver.ts apps/pane-view/src/features/gallery/useWindowedThumbnailResolution.ts apps/pane-view/src/features/gallery/batched-thumbnail-resolver.test.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `fd5693d`, 2026-07-13
- **Original finding**: 6

## Why this matters

The resolver sends only the first 48 eligible visible requests. If those resolve terminally, the hook
sees no cached pending item and never schedules the remaining uncached requests. The client must
drain successive bounded batches without increasing the server's documented maximum of 48.

## Current state

- `batched-thumbnail-resolver.ts:140` slices eligible requests to 48.
- `getNextPendingThumbnailRetryMs` considers only cached `pending` entries.
- `useWindowedThumbnailResolution.ts:56-75` stops scheduling when that helper returns `null`.
- Existing tests reset the module cache and mock `resolveMediaDeliveryUrls`; follow that pattern.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused tests | `pnpm --filter @latch-works/pane-view test -- src/features/gallery/batched-thumbnail-resolver.test.ts` | all pass |
| Pane check | `pnpm --filter @latch-works/pane-view check` | exit 0 |

## Scope

**In scope**: the resolver, windowed hook, and their focused tests.

**Out of scope**: raising the server batch limit; changing Shutter retry timing; gallery virtualization;
`GalleryPage` decomposition.

## Git workflow

- Branch: `codex/028-drain-thumbnail-batches`
- Commit message: `Drain windowed thumbnail batches`

## Steps

### Step 1: Expose remaining eligible work

Return an explicit `hasEligibleRequests`/`remainingCount` signal from the resolver, or add a helper
that distinguishes uncached eligible requests from delayed pending retries. Do not mark requests in
flight until their actual 48-item batch is submitted.

**Verify**: a unit test with 49 immediately-ready items observes two calls sized 48 and 1.

### Step 2: Drain without a tight loop

Have the hook schedule the next eligible batch on a microtask/zero-delay timer after applying the
current result. Continue using `nextRetryAt` for genuine Shutter pending results. Cleanup must cancel
both drain and retry timers when the window/reset key changes.

**Verify**: tests cover 97 ready items, mixed pending + uncached items, duplicate requests, window
replacement during drain, and terminal failures.

## Test plan

Extend `batched-thumbnail-resolver.test.ts`; add a hook test only if timer cleanup cannot be proven at
the resolver level. Use fake timers for drain/retry separation and assert no call exceeds 48 items.

## Done criteria

- [ ] 49+ eligible requests all resolve without scrolling or changing the window.
- [ ] No request batch exceeds 48.
- [ ] Pending backoff remains honored.
- [ ] Cleanup prevents stale window requests.
- [ ] Focused tests and Pane check pass.

## STOP conditions

- Fixing the client requires changing the server's 48-item contract.
- A proposed loop can issue unbounded synchronous requests.
- Existing cache semantics changed since the planned commit.

## Maintenance notes

Keep “more eligible work” distinct from “pending until a future time.” Conflating them recreates this
bug whenever the batch size or visible overscan changes.
