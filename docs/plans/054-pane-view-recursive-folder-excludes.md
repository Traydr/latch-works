# Plan 054: Pane View folder excludes for recursive and comic mode

> **Executor instructions**: This is a product feature settled with the product owner in a grilling
> session on 2026-08-21; the decisions below are final — do not re-ask them. Land as one PR on one
> branch, commit per step, run every gate, and update the plan index in the landing commit.
>
> **Drift check (run first)**: `git diff --stat a7e9a6d..HEAD -- apps/pane-view/src` — if the
> gallery feature, library service, or server library modules have moved since this plan was
> written, re-verify the file references in each step before starting.

## Status

- **Status**: IN REVIEW (branch `agent/054-recursive-folder-excludes`, implemented 2026-08-24; PR #106)
- **Priority**: P2 — product feature the owner asked for; frame-view parity
- **Effort**: M
- **Risk**: LOW–MEDIUM (touches the one place browse scope becomes SQL; fully test-gated)
- **Depends on**: PR #98 (merged `d99af8e`); plan 053 is independent — no ordering constraint
- **Category**: feature
- **Planned at**: commit `a7e9a6d`, 2026-08-21

## Why this matters

Frame View lets the user exclude subfolders from a recursive scan; Pane View has no equivalent, so
recursive and comic mode always aggregate the entire subtree. The product owner wants the same
curation in Pane View: while browsing a folder recursively (or in comic mode), quickly exclude some
of its direct child folders from the aggregation. Plan 048's product decisions already reserved this
("root preferences stay and will grow a per-root recursive-exclusion list in a future plan").

## Settled product decisions (2026-08-21, do not re-ask)

1. **Scoping — per browse path.** Excludes are keyed to the folder they were configured in. For
   browse path `X`, the excludable set is `X`'s direct child folders. Browsing recursively from a
   different level uses that level's own list. (This matches frame-view, which supports recursion
   and excludes in subfolders too.)
2. **Persistence — client-side localStorage.** Per-browser by design; excludes are not part of
   shareable URLs and do not sync across devices.
3. **Transport — excludes ride the request only when `recursive` or `comic` is true.** Plain
   direct-children browsing sends nothing and the server applies nothing. The server subtracts the
   excluded subtrees in SQL.
4. **UI — a lean dialog, not frame-view's navigator.** A folder-icon button in the floating
   toolbar, to the right of the Comic button, visible only while recursive or comic mode is on.
   It opens a dialog listing the direct child folders of the current path, each with an
   include/exclude toggle. No breadcrumbs, no browse-into. Toggling takes effect immediately.
5. **Button states.** When the current folder has no direct child folders, the button renders
   disabled with a tooltip. When the current path has a non-empty exclude list, the button carries
   a small dot indicator — no count.
6. **No effect outside recursive/comic aggregation.** Search results are untouched. Non-recursive
   browsing is untouched: an excluded folder opens and behaves normally. The main gallery shows no
   folder tiles in recursive/comic mode, so the exclude state is visible in exactly two places:
   the dialog's toggles and the toolbar dot.
7. **Stale entries auto-prune.** When the dialog opens against a freshly loaded children list,
   stored paths no longer present under that browse path are silently dropped from storage.

## Current state

- `apps/pane-view/src/server/library/library-conditions.ts` — `buildLibraryConditions` is "the one
  place the browse scope (path, recursive, query) becomes SQL"; snapshot reads, gallery listing,
  and comic listing all start from it. Subtree scope is a single
  `ilike(libraryEntries.logicalPath, '${prefix}/%')` via `resolveMediaScope`.
- `apps/pane-view/src/features/library/library-service.ts` — `libraryRequestSchema` and
  `galleryListingRequestSchema` validate the client requests; `getGalleryListing` folds
  `comic ⇒ recursive` and dispatches to `readDatabaseComicListing` or
  `readDatabaseGalleryListing`.
- `apps/pane-view/src/features/gallery/useGalleryBrowseState.ts` — URL owns `path`, `recursive`,
  `comic`; `foldBrowseFlags` states the folding rules once; request builders derive the snapshot
  and listing requests from the resolved state.
- `apps/pane-view/src/features/gallery/gallery-browse-storage.ts` — the `GalleryBrowseStorage`
  adapter over two localStorage keys (`pane-view.state`, `pane-view.root-preferences`), with a
  memory implementation for tests. Storage failures never break browsing.
- `apps/pane-view/src/features/gallery/FloatingToolbar.tsx` — Recursive → Comic → Sort →
  (Shuffle) → Refresh; buttons use `toolButtonClass`, lucide icons, `title` tooltips.
- The snapshot (`getLibrarySnapshot`) returns the direct child folders of `currentPath` regardless
  of recursive mode (`folderConditions` always pin `parentPath = currentPath`), so the dialog and
  the button's disabled/dot state need no new endpoint — the browse session's snapshot already
  carries the children.
- `apps/pane-view/src/server/library/gallery-listing.pglite.test.ts` and
  `comic-listing.ts`/`repository.ts` tests cover the read paths under pglite.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused tests | `pnpm --filter @latch-works/pane-view test` | all pass |
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint | `pnpm lint:all` | exit 0 |
| Full suite | `pnpm test` | all pass |

## Scope

**In scope**: exclude storage + adapter methods, request schema/plumbing, SQL subtraction in
`buildLibraryConditions`, toolbar button + dialog, auto-prune, tests for every layer.

**Out of scope**: server-side persistence or cross-device sync of excludes; excludes in search;
any change to frame-view; folder-tile visual treatment (recursive/comic mode shows no folder
tiles); excluding folders deeper than direct children of the current path.

## Git workflow

- Branch: `agent/054-recursive-folder-excludes`, pushed to `origin` before recording as IN PROGRESS
- Commit messages: short imperative, one per step

## Steps

### Step 1: Server — subtract excluded subtrees in `buildLibraryConditions`

Add `excludedPaths?: readonly string[]` to `LibraryConditionsInput`. Apply it only when the media
scope resolves to `subtree` mode and not when searching: for each excluded path, push
`NOT ilike(libraryEntries.logicalPath, '${escapeLikePattern(excluded)}/%')` (drizzle `notIlike`,
or `not(ilike(...))`). Direct files inside an excluded folder have `logicalPath` =
`excluded/file.jpg`, so the prefix match covers the whole subtree in one condition per path.

Guard at this boundary: ignore any entry that is not a direct child of `currentPath`
(`excluded === currentPath + "/" + <single segment>` after normalization). This makes stale or
malformed client data inert without erroring.

Folder conditions stay untouched — excluded folders remain visible as direct children everywhere.

**Verify**: unit tests beside the existing conditions coverage; then pglite tests in Step 2.

### Step 2: Server — accept `excludedPaths` in the request schemas

In `library-service.ts`, add `excludedPaths: z.array(z.string()).max(200).optional()` to both
`libraryRequestSchema` and `galleryListingRequestSchema`. Normalize each entry with the same
`normalizeLibraryPath` treatment as `path`. Thread the value into
`readDatabaseLibrarySnapshot`, `readDatabaseGalleryListing`, and `readDatabaseComicListing`
requests, and from there into `buildLibraryConditions`. When `recursive` is false (after the
`comic ⇒ recursive` fold), drop the field before it reaches the conditions.

Comic grouping derives from media entries, so pruning media prunes the comics; `getGalleryComic`
(the reader's single-comic fetch) intentionally stays exclude-free — an excluded comic simply
never appears in the listing.

**Verify**: pglite tests — a recursive listing with an excluded child returns no media from that
subtree but still lists the folder as a child; a comic listing with an excluded child contains no
comic summaries from that subtree; a *search* with the same excludes still returns matches from
the excluded folder; a non-recursive request with `excludedPaths` set behaves as if it were
absent; an `excludedPaths` entry outside the current path is ignored.

### Step 3: Client — exclude storage on the browse-storage adapter

In `gallery-browse-storage.ts`, add a third localStorage key (e.g.
`pane-view.recursive-excludes`) holding a record of browse path → excluded direct-child paths,
parsed tolerantly like the existing keys (malformed record ⇒ `{}`). Extend `GalleryBrowseStorage`
with `readExcludedChildPaths(path): string[]` and
`writeExcludedChildPaths(path, paths: string[]): void` (dedupe on write; writing an empty list
deletes the path's entry so the record does not grow unboundedly). Mirror both in
`createMemoryBrowseStorage`. Leave `pane-view.root-preferences` untouched.

**Verify**: adapter tests — round-trip, dedupe, empty-list removal, malformed stored JSON falls
back to empty, storage unavailability (server render / quota) never throws.

### Step 4: Client — excludes join the browse session and the requests

In `useGalleryBrowseState.ts` (and `useGalleryBrowse.ts` where the requests are actually issued),
hold the current path's exclude list in state, hydrated from storage whenever `path` changes, with
an intent to toggle a child (write-through to storage). Include the list in the listing request
builder **only when the folded `recursive` is true**, trimmed to the server cap, and make it part
of the listing query key (and the browse key, so accumulated pages reset) so toggling refetches
immediately. A path with no stored entry contributes nothing to the request.

*Deviation (2026-08-24, implementation):* the snapshot request does **not** carry excludes. The
browse snapshot is fetched with `mediaLimit: 0`, so excludes cannot change a row it returns, and
putting them on its query key would refetch the snapshot on every toggle — flipping it to
placeholder data and blanking the open dialog mid-interaction. Only the listing request carries
`excludedPaths`; the snapshot schema and repository read never accept the field.

Add the auto-prune: when the exclude dialog opens (Step 5) and the snapshot's children for the
current path are loaded and current (not placeholder data), drop stored paths not present among
those children and persist the pruned list.

**Verify**: hook tests — toggling an exclude changes the outgoing listing request and query key;
navigating to another path swaps to that path's list; recursive off ⇒ no `excludedPaths` in any
request; prune removes only genuinely absent paths and never runs against placeholder data.

### Step 5: Client — toolbar button and exclude dialog

`FloatingToolbar.tsx`: add a folder-icon button (lucide `FolderMinus` or similar) immediately
right of the Comic button, rendered only when `recursive || comicMode`. Disabled with
`title="No subfolders to exclude"` when the current path has no direct child folders; small dot
indicator (absolute-positioned, `bg-primary`-style accent — no count) when the active exclude
list is non-empty. Follow the existing `toolButtonClass` / `aria-pressed` idiom.

New `FolderExcludeDialog.tsx` in the gallery feature: a dialog (reuse the project's existing
dialog/popover primitive if one exists under `components/ui`, otherwise match the sort menu's
popover idiom) listing the current path's direct child folders from the snapshot, each row a
toggle between Included and Excluded, one click per row, effect immediate. Fire the Step 4
auto-prune on open.

**Verify**: component tests — button hidden when neither mode is on; disabled state with no
children; dot appears/disappears with the list; dialog toggle round-trips through the session
intent and storage.

### Step 6: Gates and index

Run the focused pane-view suite, then `pnpm test`, `pnpm typecheck`, `pnpm lint:all`. Update the
plan index row in the landing commit. Verify the toolbar + dialog live and describe what was seen
in the PR body (the owner prefers prose over committed screenshots; leave any PNG in `/tmp`).

## Test plan

Every step above is test-gated at its own layer: conditions unit tests (Step 1), pglite read-path
tests (Step 2), storage adapter tests (Step 3), browse-session hook tests (Step 4), component
tests (Step 5). Cover the failure paths CLAUDE.md asks for: storage unavailable, malformed stored
JSON, over-cap or out-of-scope `excludedPaths` in the request.

## Done criteria

- [x] Recursive and comic listings subtract excluded subtrees server-side; search and
      non-recursive browsing are provably unaffected.
- [x] Excludes persist per browse path in localStorage behind the storage adapter, with
      auto-prune on dialog open.
- [x] Toolbar shows the folder button only in recursive/comic mode, disabled without children,
      dot when excludes are active.
- [x] The dialog lists direct children with one-click include/exclude toggles and immediate
      effect.
- [x] `excludedPaths` is absent from every request when recursive (post-fold) is false.
- [x] Plan index row updated in the landing commit; PR describes the live toolbar + dialog
      verification in prose.

## STOP conditions

- A step requires excludes deeper than direct children of the current path, or a server-side
  persistence store — both are explicitly out of scope; record the need and stop.
- `buildLibraryConditions` changes would alter behavior for requests *without* excludes (existing
  pglite tests are the tripwire).
- The dialog needs data the snapshot does not already carry (a new endpoint) — stop and record;
  the settled design assumes the snapshot's children suffice.
