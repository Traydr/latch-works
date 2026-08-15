# Plan 048: One browse-state module for the Pane View gallery

> **Executor instructions**: This is a client-only refactor with no schema or route changes. Land it
> as one branch in the step order below; each step leaves the app working. Update the index when done.
>
> **Drift check (run first)**: `git diff --stat 7076ce8..HEAD -- apps/pane-view/src/features/gallery apps/pane-view/src/features/library apps/pane-view/src/features/settings/useAppSettings.ts apps/pane-view/src/routes/_gallery`
> If `useGalleryPreferences.ts`, `useGalleryState.ts`, `GalleryPage.tsx`, `GalleryLayout.tsx`, or
> `library-queries.ts` changed materially, re-read them before Step 1 and re-verify the "Current
> state" line references.

## Status

- **Status**: TODO
- **Priority**: P2
- **Effort**: L
- **Risk**: MEDIUM — touches the hottest file in the app; behaviour must not change
- **Depends on**: —
- **Category**: architecture / perf
- **Planned at**: commit `7076ce8`, 2026-08-14
- **Original finding**: Pane View architecture review 2026-08-14, candidate 3

## Why this matters

Gallery browse state — path, query, selected media, recursive, comic mode, sort mode, random seed,
detail panel — has no single owner. It is reconciled across `useGalleryPreferences`,
`useGalleryState`, `useRootPreferences`, `library-queries`, `GalleryPage`, and `GalleryLayout`, with
four candidate sources of truth per flag (URL search, override state, localStorage, root prefs).
Answering "why did the selection jump" or "why did recursive turn itself back on" means opening eight
files. The `comic ⇒ recursive` rule is written six times across the seam. And because three callers
build the snapshot request three different ways, one URL yields up to three live `library-snapshot`
query keys — and the sidebar's key fetches 500 media rows it never renders.

Deepening this into one module gives every consumer the same browse request, states each rule once,
and makes the reconciliation testable through one interface instead of through jsdom renders of
`GalleryPage`.

## Current state

All references are to `apps/pane-view/src/`.

- `features/gallery/useGalleryPreferences.ts:59-74` — per-flag cascade
  `override ?? (galleryStateReady ? persisted.X : DEFAULT.X)`, with `search.recursive` /
  `search.comic` as an extra layer for two of the four flags.
- `useGalleryPreferences.ts:53` destructures only `savePreferences` from `useRootPreferences`. **No
  code reads root preferences back.** `useAppSettings.ts:85-109` `useRootPreferences.preferences` has
  zero consumers. This layer is a write-only sink.
- `useGalleryPreferences.ts:177` writes `lastSelectedId` to localStorage; nothing reads it.
- `useGalleryState.ts` exposes eight setters; only `setPreferences` is called (by
  `useGalleryPreferences.ts:172`).
- `comic ⇒ recursive` is encoded at: `useGalleryPreferences.ts:112`, `library-queries.ts:41`
  (`toLibrarySnapshotRequest`), `library-queries.ts:55` (`toGalleryRouteLoaderDeps`, a near-twin
  differing only in `mediaLimit`), `library-service.ts:94` and `:133` (server), and imperatively at
  `GalleryPage.tsx:703-718` (`onToggleComicMode` calls `setRecursive(next)`; `onToggleRecursive`
  calls `setComicMode(false)`).
- Snapshot request is built three ways:
  - `routes/_gallery/index.tsx:14` — `toGalleryRouteLoaderDeps(search)` (URL flags, `mediaLimit: 0`)
  - `GalleryPage.tsx:102-109` — `{ ...toLibrarySnapshotRequest(search), comicMode: effectiveComicMode,
    recursive: effectiveRecursive, mediaLimit: effectiveComicMode ? undefined : 0 }` — overwrites the
    flags it just derived
  - `GalleryLayout.tsx:22` — `toLibrarySnapshotRequest(search)` (URL flags, **no `mediaLimit`**) →
    server defaults to `DEFAULT_MEDIA_PAGE_LIMIT = 500` (`library-service.ts:15,97-102`)
- `GalleryPage.tsx:171-188` — selection reconciliation effect against `search.media` and `allMedia`;
  `:212-227` — deleted/deleting-set reconciliation.
- `useGalleryPreferences.ts:197-221` — effect that pushes `recursive`/`comic` back into the URL with
  `replace: true` whenever they disagree with `search`.
- `gallery-shell-context.tsx` (33 lines) — mutable-ref callback registry whose only purpose is letting
  `ArchiveSidebar` (in `GalleryLayout`) open the settings drawer owned by `GalleryPage`.
- Tests: `useGalleryPreferences.test.tsx` has two cases, both about initial-path redirect.
  `useGalleryBrowse.ts` has no test. `library-queries.test.ts` covers the two request builders.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Gallery + library tests | `pnpm --filter @latch-works/pane-view test -- src/features/gallery src/features/library` | all pass |
| Pane check | `pnpm --filter @latch-works/pane-view check` | exit 0 |
| Lint | `pnpm lint` | no new diagnostics in touched files |
| Manual smoke | `pnpm dev:pane` → log in → `/?path=<folder>` | see Step 6 checklist |

## Scope

**In scope**: a new `features/gallery/useGalleryBrowseState.ts` module; retiring
`useGalleryPreferences.ts`, `useGalleryState.ts`, `useRootPreferences`, `gallery-shell-context.tsx`,
and `toGalleryRouteLoaderDeps`; rewiring `GalleryPage.tsx`, `GalleryLayout.tsx`,
`routes/_gallery/index.tsx`; new tests at the module's interface.

**Out of scope**: `useGalleryBrowse.ts` pagination internals (it becomes a consumer of the new
module's request, nothing more); server-side normalization in `library-service.ts` (keep exactly one
server copy of `comic ⇒ recursive` — it is the server's defence, not duplication); the thumbnail
resolution stack (candidate 1); the viewer session (candidate 6); URL search-param names.

## Decisions taken in this plan

State them in the PR. If the user overrules any, the plan changes shape — see STOP conditions.

1. **URL is the source of truth for `path`, `q`, `media`, `recursive`, `comic`.** localStorage seeds
   them only on a first visit with no `path` in the URL (existing behaviour at
   `useGalleryPreferences.ts:150-167`). After that, changes go URL-first; localStorage mirrors.
2. **`sortMode`, `randomSeed`, `detailPanelOpen` stay localStorage-only** — they are not URL params
   today and this plan does not add them.
3. **Root preferences are deleted.** They are written and never read. If the user intends to read
   them somewhere planned, STOP and ask.
4. **`lastSelectedId` is deleted** from persisted state for the same reason.
5. **The override layer goes away.** A setter writes to the URL (for URL-owned fields) or to
   localStorage (for local-owned fields) directly. React state holds only what is neither: the
   pending search draft, focus index, scroll key, and the transient deleting/deleted sets.

## Git workflow

- Branch: `agent/048-gallery-browse-state`
- Commit message: `Deepen Pane View gallery browse state`

## Steps

### Step 1: Define the interface and write the tests first

Create `features/gallery/useGalleryBrowseState.ts` exporting:

```ts
export interface GalleryBrowseState {
  // resolved, single-valued — no "effective" vs "raw" pairs
  path: string;                 // "" = archive root
  query: string | undefined;
  selectedId: string | null;
  recursive: boolean;           // already folded: comic ⇒ recursive; root ⇒ false
  comicMode: boolean;           // root ⇒ false
  folderModesEnabled: boolean;
  sortMode: GallerySortMode;
  randomSeed: number;
  detailPanelOpen: boolean;
  hydrated: boolean;            // URL + localStorage both read
  // one request every consumer uses
  snapshotRequest: LibrarySnapshotRequest;      // page/loader/sidebar all use this
  listingRequest: GalleryListingQueryRequest;
  // intents
  navigateToPath(path: string): void;
  submitSearch(query: string | undefined): void;
  selectMedia(mediaId: string | null): void;
  setRecursive(next: boolean): void;
  setComicMode(next: boolean): void;
  setSortMode(next: GallerySortMode): void;
  shuffle(): void;
  setDetailPanelOpen(next: boolean): void;
  buildBrowseSearch(patch: Partial<GalleryBrowseSearch>): GalleryBrowseSearch;
}
```

Accept `{ search, navigate, settings: { showImages, showVideos } }` and two injectable adapters with
in-memory defaults for tests: `storage: { read(): PersistedBrowseState | null; write(s): void }` and
`clock/seed: () => number`. The hook is the only React-aware layer; put the pure reconciliation in a
plain function `resolveBrowseState(search, persisted, hydrated): ResolvedBrowseState` in the same
file so tests can hit it without a render.

Write `useGalleryBrowseState.test.ts` (node environment, no jsdom) against `resolveBrowseState` and
a small pure `applyIntent` covering:

- root path forces `recursive=false`, `comicMode=false`, `folderModesEnabled=false`
- `comic=true` in a folder implies `recursive=true`
- turning recursive off turns comic off; turning comic on turns recursive on
- URL flag wins over persisted flag; persisted flag used when URL flag is `undefined`
- first visit with no `path` and a persisted `lastPath` yields a redirect intent; second visit does not
- `snapshotRequest` for the same input is referentially stable across calls (memoised) and has
  `mediaLimit: 0` unless `comicMode`
- `shuffle()` sets `sortMode="random"` and changes `randomSeed`

**Verify**: new test file passes; nothing else changed yet.

### Step 2: Implement the module

Move logic from `useGalleryPreferences.ts` and `useGalleryState.ts` into the new module. Keep the
localStorage key `"pane-view.state"` and its shape minus `lastSelectedId` so existing browsers keep
their preferences (the reader already tolerates missing fields, `useGalleryState.ts:29-58`).

The URL-sync effect (`useGalleryPreferences.ts:197-221`) is replaced by the intents writing to the
URL directly; the only remaining effect is the one-shot first-visit redirect. Delete the
`*Override` state entirely.

**Verify**: Step 1 tests still pass against the real module; `pnpm typecheck` passes with the new
file unused.

### Step 3: Rewire the three snapshot consumers to one request

- `routes/_gallery/index.tsx` — `loaderDeps` uses a new pure export
  `browseSnapshotRequestFromSearch(search)` from the module (URL-only, `mediaLimit: 0` unless comic).
  Delete `toGalleryRouteLoaderDeps`.
- `GalleryLayout.tsx:22` — use `useGalleryBrowseState().snapshotRequest`. **This is the perf fix:**
  the sidebar stops fetching 500 media rows.
- `GalleryPage.tsx:102-132` — delete the two `useMemo` request builders; take `snapshotRequest` and
  `listingRequest` from the module.

`toLibrarySnapshotRequest` keeps one caller (`GalleryLayout` no longer) — fold it into the module
and delete it from `library-queries.ts` along with `library-queries.test.ts`'s cases for it (they
move to Step 1's test file). Update `gallery-page-helpers.test.ts:3,70,76`, which import it.

**Verify**: with dev server running and React Query devtools (or a `console.log` in
`librarySnapshotQueryOptions`), navigating to a folder produces exactly one `library-snapshot` key
for the page and sidebar combined, plus at most one for the loader with an identical key. Network
tab shows the sidebar snapshot response has `media: []`.

### Step 4: Shrink `GalleryPage`

Replace the `useGalleryPreferences` call and the toolbar's imperative coupling
(`GalleryPage.tsx:703-718`) with the module's `setComicMode` / `setRecursive`. Remove the selection
reconciliation effect at `:171-188` — `selectedId` now derives from `search.media ?? first visible`
inside the module, and `selectMedia` writes the URL. Keep `focusedEntryIndex`, `scrollRequestKey`,
overlay booleans, `searchDraft`, `activeComic`, and the deleting/deleted sets in `GalleryPage` —
they are page chrome, not browse state.

Hoist `settingsOpen` into `GalleryLayout` (which renders both `ArchiveSidebar` and the `Outlet`) and
delete `gallery-shell-context.tsx` and the register/unregister effect at `GalleryPage.tsx:162-165`.
Pass `onOpenSettings` down as a prop or via the existing layout context.

**Verify**: `GalleryPage.tsx` no longer imports `useGalleryPreferences`, `useGalleryShell`, or
`toLibrarySnapshotRequest`; the 60-key context object drops the twelve fields now owned by the
module (`recursiveToggleDisabled`, `effectiveComicMode`, `effectiveRecursive`, `sortMode`,
`setSortMode`, `setRecursive`, `setComicMode`, `setDetailPanelOpen`, `shuffle`, `selectedId`,
`showDetailPanel` stays).

### Step 5: Delete the retired modules

Remove `useGalleryPreferences.ts` + `.test.tsx`, `useGalleryState.ts`, `gallery-shell-context.tsx`,
`useRootPreferences` and `readRootPreferences`/`writeRootPreferences` from `useAppSettings.ts`, and
`toGalleryRouteLoaderDeps`. Run `pnpm knip` if configured (`knip.json` exists at repo root) to catch
stragglers.

**Verify**: `pnpm --filter @latch-works/pane-view check` passes; `git grep -n "useGalleryPreferences\|useGalleryState\|useRootPreferences\|useGalleryShell\|toGalleryRouteLoaderDeps" apps/pane-view/src` returns nothing.

### Step 6: Manual smoke

With `pnpm dev:pane` and a synced archive:

- [ ] Fresh browser (cleared localStorage) at `/` shows archive root; navigate into a folder; reload
      → stays in folder; open `/` in a new tab → redirected to last folder (first-visit seed).
- [ ] Toggle recursive on → URL gains `recursive=true`; toggle comic on → URL gains `comic=true`,
      recursive stays on; toggle recursive off → both drop from URL.
- [ ] Navigate to root with recursive on → URL has neither flag; toolbar toggles disabled.
- [ ] Sort mode and shuffle survive reload; detail panel open/closed survives reload.
- [ ] Select a tile → URL `media=` updates; delete it → selection moves to neighbour.
- [ ] Sidebar settings button opens the drawer.
- [ ] Back/forward buttons walk path history without flag flicker (no `replace` loop).

## Test plan

Node-environment tests against `resolveBrowseState`/`applyIntent` (Step 1) replace the two jsdom
cases in `useGalleryPreferences.test.tsx`; port the "explicit navigation to root from a persisted
child folder stays at root" case, since it guards a real regression (`052081e`). Keep
`gallery-page-helpers.test.ts` and `library-queries.test.ts` for what remains in those files.

## Done criteria

- [ ] One module exports the browse state and every intent; `GalleryPage`, `GalleryLayout`, and the
      route loader consume it.
- [ ] `comic ⇒ recursive` appears once on the client and once on the server.
- [ ] One `library-snapshot` query key per URL for page + sidebar; sidebar response carries no media.
- [ ] Root preferences, `lastSelectedId`, override state, and `gallery-shell-context` are gone.
- [ ] Reconciliation is covered by node tests at the module interface.
- [ ] Step 6 checklist passes; `pnpm --filter @latch-works/pane-view check` passes.

## STOP conditions

- The user says root preferences are meant to be read somewhere planned (then keep them behind the
  new module's `storage` adapter instead of deleting; re-scope Step 5).
- The user wants `sortMode` or `detailPanel` in the URL — a different plan; do not add URL params here.
- The first-visit redirect cannot be expressed as a one-shot intent without reintroducing an
  override layer — pause and describe the case before adding state.

## Maintenance notes

The module's `snapshotRequest` is the only thing that should ever be passed to
`useLibrarySnapshotQuery` from gallery code. Reviewers should reject any new `toLibrarySnapshotRequest`-
style builder outside it. `useGalleryBrowse.ts` remains a candidate for its own deepening (two
pagination models behind one surface, untested); it is intentionally untouched here.
