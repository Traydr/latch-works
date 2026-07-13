# Plan 038: Fetch the comic folder tree once per browse key

> **Executor instructions**: Keep first-page comic grouping unchanged and make later pages omit only
> the already-held folder tree. Run every gate and update the plan index.
>
> **Drift check (run first)**: `git diff --stat fd5693d..HEAD -- apps/pane-view/src/features/library/library-service.ts apps/pane-view/src/server/library/repository.ts apps/pane-view/src/features/gallery/GalleryPage.tsx apps/pane-view/src/features/library/*.test.ts`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `fd5693d`, 2026-07-13
- **Original finding**: 17

## Why this matters

Comic-mode snapshots request every active folder. Every 500-media “load more” repeats that same full
tree, then `GalleryPage` discards it. Large archives spend bandwidth and DB work retransmitting stable
structure. The initial request should fetch the tree; subsequent pages for the same browse key should
explicitly omit it.

## Current state

- `library-service.ts:91-105` forces `includeAllFolders: comicMode`.
- `repository.ts:114-119` selects every non-deleted folder when enabled.
- `GalleryPage.tsx:928-938` repeats comic mode on load-more and keeps only media/page state.
- `LibrarySnapshot` already permits `allFolders: []`; preserve its response shape.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Library tests | `pnpm --filter @latch-works/pane-view test -- src/features/library src/server/library` | all pass |
| Pane check | `pnpm --filter @latch-works/pane-view check` | exit 0 |

## Scope

**In scope**: library request schema/service/tests; GalleryPage load-more request; repository tests only
if query invocation needs explicit coverage.

**Out of scope**: changing the 500 media page size; source-post collections; gallery listing cursor
mode; caching across users/sessions; splitting GalleryPage.

## Git workflow

- Branch: `codex/038-avoid-repeating-comic-folder-tree`
- Commit message: `Avoid repeated comic folder payloads`

## Steps

### Step 1: Add an explicit all-folder request flag

Add a validated `includeAllFolders`/`includeComicFolders` boolean. For backward-compatible initial
comic requests, default it to `comicMode`; when explicitly false, pass false to the repository while
keeping recursive media behavior true.

**Verify**: service tests cover initial comic request -> true and paged comic request with false -> false.

### Step 2: Omit the tree on load-more

In `GalleryPage.loadMoreMedia`, pass the explicit false flag after initial snapshot state exists. Do
not overwrite the initial `library.allFolders` with the empty later response. Reset behavior must
still refetch the tree when path/query/comic browse key changes.

**Verify**: helper/component test performs two pages, asserts only first repository call includes all
folders, and confirms comic grouping still has the initial tree.

### Step 3: Confirm payload/query reduction

With mocked repository results containing many folders, compare serialized page payloads and call
counts. Record the reduction in the PR description.

**Verify**: second-page response contains `allFolders: []` and no all-folder select is invoked.

## Test plan

Extend `library-service.test.ts` and add a focused load-more helper test rather than mounting the full
GalleryPage if possible. Cover path change, comic toggle, query change, and page failure/retry.

## Done criteria

- [ ] First comic page fetches the complete active folder tree.
- [ ] Later pages for the same browse key do not query or return it.
- [ ] Browse-key changes refetch it.
- [ ] Comic grouping/pagination behavior remains unchanged.
- [ ] Focused tests and Pane check pass.

## STOP conditions

- Later pages currently depend on fresh folder rows for correctness beyond data that is discarded.
- The fix would cache one user's folder data across authenticated sessions.
- Browse-key reset semantics cannot be characterized without a broad GalleryPage refactor.

## Maintenance notes

If sync-driven live updates are added later, invalidate/refetch the folder tree explicitly; do not
restore unconditional transfer on every media page.
