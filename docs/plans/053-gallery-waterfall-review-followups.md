# Plan 053: Gallery waterfall review follow-ups

> **Executor instructions**: These are five small, independent cleanups from the review of PR #98.
> None changes the perf characteristics that PR measured; if a step forces you to, STOP. Land as one
> PR with one commit per step, run every gate, and update the plan index.
>
> **Drift check (run first)**: `git diff --stat d99af8e..HEAD -- apps/pane-view/src/features/gallery apps/pane-view/src/routes/_gallery`
> — if the gallery feature has moved since PR #98's merge commit, re-verify each finding below still
> exists before fixing it.

## Status

- **Status**: TODO
- **Priority**: P3 — polish; nothing is broken, one behaviour edge fires an extra request
- **Effort**: S
- **Risk**: LOW
- **Depends on**: PR #98 (merged 2026-08-21, `d99af8e`)
- **Category**: cleanup / test coverage
- **Planned at**: commit `d99af8e`, 2026-08-21, from the two-axis review of PR #98

## Why this matters

PR #98 removed the fresh-folder request waterfall and was merged with these findings accepted as
follow-ups. They are recorded here so they don't evaporate: one behavioural edge case, one missing
failure-path test that CLAUDE.md's testing guidance asks for, two drift risks (duplicated staleness
logic, naming drift), and one deferred simplification the PR body itself calls "worth a follow-up".

## Current state

All paths relative to `apps/pane-view/src/features/gallery/` unless noted.

1. **Mid-scroll batch on folder-first windows.** In `useWindowedThumbnailResolution.ts`,
   `seenContentKeyRef` is only written when the effect passes its guard
   (`contentKey !== null && windowedThumbnailRequests.length > 0`). A fresh folder whose first
   window is folder-tiles-only never sets the ref, so the first scroll step that brings media into
   view compares as *new content* and takes the synchronous resolve path — firing a batch mid-scroll
   instead of debouncing. Consequence: one extra request in a narrow case, not stale data.
2. **No rejection-path test for the resolver.** `batched-thumbnail-resolver.ts` has a `catch`
   branch (network rejection → all batch keys re-marked `pending` with a 30s `nextRetryAt`), and
   the in-flight-batch wait loop leans on the comment "Batches never reject; they settle to cache
   state" — but no test exercises a *rejected* `resolveUrls` call, only server-declared
   `pending`/`failed` statuses.
3. **Duplicated staleness logic.** `GalleryLayout.tsx` derives `foldersDisabled` from its own
   snapshot query's `isPlaceholderData` while `useGalleryBrowse` exports the same fact as
   `snapshotIsCurrent`, and `browse` is already in scope in the layout. Two sites encode
   "placeholder snapshot ⇒ inert snapshot consumers".
4. **Naming drift.** One value wears three names along its path: `contentBrowseKey`
   (`useGalleryBrowse` session) → `contentKey` (props through `GalleryPage.tsx`,
   `GalleryBrowsePane.tsx`, `BrowserGrid.tsx`) → `key` (in `WindowedListing`, where it also
   collides mentally with React's `key`).
5. **`library` still lives on the browse session.** `GalleryLayout` already runs the same snapshot
   query; `useGalleryBrowse` exposing `library` duplicates the subscription. The PR #98 body defers
   this deliberately because it widens the diff — that reason expires once the change is its own PR.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused tests | `pnpm --filter @latch-works/pane-view test` | all pass (582+ at plan time) |
| Typecheck | `pnpm --filter @latch-works/pane-view typecheck` | exit 0 |
| Lint | `pnpm run lint:biome && pnpm run lint:oxlint` | exit 0 |

## Scope

**In scope**: the five items above, each as its own commit.

**Out of scope**: any change to the measured request waterfall (loader prefetch, `isReady`,
`contentBrowseKey` derivation); the hard-page-load hydration gap (listing waits ~530ms for
localStorage sort mode — pre-existing, belongs to a future plan); speculative folder prefetch
(deferred by the product owner, revisit only on request).

## Git workflow

- Branch: `agent/053-gallery-review-followups`, pushed to `origin` before recording as IN PROGRESS
- Commit messages: short imperative, one per step

## Steps

### Step 1: Debounce the first scroll on folder-first windows

In `useWindowedThumbnailResolution.ts`, mark the content key as seen whenever the listing on screen
is real, not only when it produced requests: move the `seenContentKeyRef` write above the
`windowedThumbnailRequests.length === 0` early-return while keeping it below (or guarded by) the
`contentKey === null` check. A placeholder must still not mark anything seen.

Add a regression test: open a folder whose first window contains only folder entries, then widen the
window to include media; the batch must go out only after the debounce elapses, not synchronously.
While there, the existing tests hardcode `advanceTimersByTimeAsync(200)` — keep the constant
unexported (that was deliberate in #98) but hoist the literal to one named local in the test file so
the coupling is visible in one place.

**Verify**: new test fails on `d99af8e`'s logic (sync fire) and passes after; the existing
"new listing resolves synchronously" and "placeholder resolves nothing" tests still pass.

### Step 2: Pin the resolver's rejection path

In `useWindowedThumbnailResolution.test.tsx` (or a resolver-focused test beside
`batched-thumbnail-resolver.ts`), drive the real resolver with a `resolveUrls` fake that **rejects**.
Assert: the returned promise settles (does not reject) to cache state; every key in the batch is
`pending` with `inFlight: false` and a ~30s `nextRetryAt`; a caller arriving while the rejecting
batch is in flight awaits it and sees the post-rejection state rather than a stale snapshot.

**Verify**: deleting the `catch` block in `resolveGalleryThumbnailsBatchFor` makes the new test fail.

### Step 3: Single source for snapshot staleness

In `GalleryLayout.tsx`, derive `foldersDisabled` from `!browse.snapshotIsCurrent` and drop the local
`isPlaceholderData` destructure. The layout's own query subscription stays (it feeds `folders` and
`showFetching`); only the staleness fact moves to the session's field.

**Verify**: the sidebar-inert behaviour is unchanged (folder buttons disabled during the
stale-snapshot round trip); grep shows `isPlaceholderData` read in exactly one place per query.

### Step 4: One name for the content key

Rename so the value is greppable end-to-end as `contentBrowseKey`: the props on
`GalleryBrowsePaneProps` and `BrowserGridProps`, and `WindowedListing.key` →
`WindowedListing.contentBrowseKey` (update its doc comment). Pure rename, no behaviour change.

**Verify**: `grep -rn "contentKey" apps/pane-view/src` returns nothing;
`grep -rn "contentBrowseKey"` traces one unbroken path from `useGalleryBrowse.ts` to
`useWindowedThumbnailResolution.ts`.

### Step 5: Remove `library` from the browse session

Drop `library` (and anything only it needed) from `GalleryBrowseSession`. `GalleryPage`'s two
consumers — `navigateSiblingFolder` and `archiveRoot` — get the snapshot from the query directly or
via the layout, whichever keeps a single subscription per mount tree. `snapshotIsCurrent` stays on
the session (Step 3 depends on it) or moves with the data; keep the two facts adjacent.

This is the widest step. If it starts pulling in components #98 didn't touch beyond
`GalleryLayout`/`GalleryPage`, stop and split it out rather than growing this PR.

**Verify**: sibling-folder navigation and the breadcrumb root label behave as on `main`, including
staying inert while the snapshot is a placeholder; `useGalleryBrowse.test.tsx`'s
"isReady from the listing alone" pin still passes; React Query devtools (or a test spy) shows one
snapshot observer per key where there were two.

## Test plan

Steps 1–2 add tests and are test-gated above. Steps 3–5 are covered by the existing
`useGalleryBrowse.test.tsx` / `useWindowedThumbnailResolution.test.tsx` suites plus typecheck; run
the full pane-view suite and `pnpm typecheck` after each step, `pnpm run lint:biome && pnpm run
lint:oxlint` before the PR.

## Done criteria

- [ ] Folder-first windows debounce the first media-bearing scroll; regression test pins it.
- [ ] A rejected `resolveUrls` call is tested: settles to cache state, 30s retry, waiters see it.
- [ ] Snapshot staleness is read from `snapshotIsCurrent` in exactly one way.
- [ ] `contentBrowseKey` is the only name for the content key.
- [ ] `GalleryBrowseSession` no longer exposes `library`, with no duplicate snapshot subscription.
- [ ] Plan index row updated in the same commit that lands the PR.

## STOP conditions

- Any step changes the request count or ordering PR #98 measured (loader prefetch, parallel
  snapshot+listing, synchronous first batch for genuinely new media content).
- Step 5 forces edits outside the gallery feature directory or grows past roughly the size of the
  other four steps combined — split it into its own plan instead.
