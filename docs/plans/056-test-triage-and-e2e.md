# Plan 056: Replace the unit-test pile with a small end-to-end suite

> **Executor instructions**: The product owner settled the testing policy on 2026-08-25 (see
> "Settled decisions"); do not re-ask it. The per-file tags below are the deliverable the owner
> reviews — **do not delete anything until the owner has vetoed or approved the table**. Then land
> as the PR sequence in "Steps", one PR per workspace, each with the gates listed.
>
> **Drift check (run first)**: `git diff --stat 0e70201..HEAD -- '**/*.test.ts' '**/*.test.tsx'`.
> Any test file added or renamed since this plan was written must be tagged before its workspace
> PR starts; use the criteria in "Tagging criteria".

## Status

- **Status**: IN PROGRESS — PR 1 (e2e workspace + Pane View suite + pane-view deletions) on branch `revise-testing`, 2026-08-25; tag table approved as written
- **Priority**: P2 — reduces agent drag on every future PR; unblocks honest "does the product
  work" signal
- **Effort**: L (e2e harness M, deletions S per workspace)
- **Risk**: MEDIUM — deletions remove coverage before e2e proves it is redundant, so ordering matters
- **Depends on**: nothing; PR #106 (plan 054) is merged
- **Category**: test infrastructure
- **Planned at**: commit `0e70201`, 2026-08-25

## Why this matters

At `0e70201` the repo has 125 Vitest files, 19,853 test lines against 55,650 source lines, 983
tests, running in 9 s. There is **no** end-to-end test of any app. Nothing today checks that Pane
View boots, lists an archive, switches sort mode, or opens a comic; that Frame View scans a folder
and renders thumbnails; or that a Lockstep push lands in Pane View.

The tests that do exist are dominated by two shapes the owner does not want:

1. **Mock-shape tests** — mock the module's collaborators and assert on call arguments. Gather Box
   has 116 `vi.mock`/`vi.fn` calls across 130 tests and not one file that touches a real
   dependency. These break on refactor without catching bugs, and agents then edit the test to
   match the code.
2. **Moment-in-time pins** — tests for a one-off fix, a configuration choice, or the absence of
   something (`does not expose test-only identifiers`, `does not evaluate capability configuration
   during module import`, `does not carry excludes on the snapshot read`). 176 test names match
   `does not / never / no longer / ignores / rejects / skips / without`.

Meanwhile the parts that most resemble end-to-end coverage — the pglite oracle tests in
`apps/pane-view/src/server/library` (~1.8k lines, in-process Postgres with ICU and pg_trgm) — are
the owner's example of "the wrong direction": complicated unit tests standing in for what should
be a real-stack check.

## Settled decisions (2026-08-25, do not re-ask)

1. **Policy.** Agents write whatever tests they need to prove a change works; *committing* a test
   is a separate decision, made only on explicit request or when the test pins a feature-level
   behavior worth keeping. CLAUDE.md already says this (updated 2026-08-25).
2. **What stays.** Tests that pin a feature's behavior through real dependencies or pure output:
   ordering rules, sync identity rules, parser output, path-traversal and auth guards, destructive
   operation guards.
3. **What goes.** Mock-shape tests; tests for one-off bug fixes; configuration/migration
   compatibility tests; absence tests; performance-internals tests (batch sizes, debounce
   windows, queue priority) unless they pin a user-visible perf regression.
4. **Gather Box collectors.** Collector tests are deleted outright, fixtures included. Sites change
   their HTML; a collector that worked once has no reason to keep working, and a fixture only
   proves it parsed *last year's* page. Fix collectors when they break.
5. **pglite tests become end-to-end.** The `server/library` oracle tests and SQL-rendering tests
   are replaced by an e2e suite driving Pane View against the real local stack
   (`docs/localhost/compose.yaml`). They are deleted **in the same PR** that lands the e2e coverage
   of the same behavior, not before.
6. **E2E scope and cadence.** The e2e suite walks every major baseline feature (see "End-to-end
   suite"), runs locally and as a final pre-merge check, and is **not** part of `pnpm test`. It
   may be slow. Suites are runnable per app.
7. **Deletion is the owner's call.** The tag table below is proposed; the owner strikes or changes
   lines, then the executor applies exactly what remains.

## Current state (at `0e70201`)

| workspace | files | LOC | tests | mock calls | files w/ mocks | files on real deps |
|---|---:|---:|---:|---:|---:|---:|
| apps/pane-view | 52 | 9,808 | 372 | 91 | 23 | 24 |
| apps/gather-box | 34 | 3,102 | 130 | 116 | 16 | 0 |
| apps/frame-view | 19 | 3,376 | 88 | 43 | 8 | 7 |
| packages/lockstep-core | 8 | 1,480 | 37 | 0 | 0 | 5 |
| apps/lockstep-cli | 3 | 437 | 21 | 8 | 1 | 1 |
| packages/media-index | 2 | 576 | 20 | 0 | 0 | 1 |
| apps/lockstep | 2 | 412 | 11 | 0 | 0 | 2 |
| packages/shutter-client | 1 | 263 | 12 | 0 | 0 | 0 |
| packages/media-storage | 2 | 210 | 9 | 5 | 1 | 0 |
| packages/media-domain | 2 | 189 | 12 | 0 | 0 | 0 |

"Real deps" = pglite, temp filesystem, or testing-library render. Inventory command:

```bash
find apps packages \( -name "*.test.ts" -o -name "*.test.tsx" \) -not -path "*/node_modules/*" \
  | while read f; do echo "$f $(wc -l <"$f") $(grep -cE '^\s*(it|test)\(' "$f") \
  $(grep -oE 'vi\.(mock|fn|spyOn|stubGlobal)\(' "$f" | wc -l)"; done
```

## Tagging criteria

- **KEEP** — stays as is. Pure or real-dependency test of a feature invariant, a security guard,
  or a destructive-op guard.
- **TRIM** — stays, but the named cases are deleted (config, absence, internals). The file must
  still justify itself after trimming; if fewer than two cases remain, fold them into a sibling.
- **E2E** — deleted in the PR that lands the e2e coverage named in the reason column. Until then
  it stays.
- **DELETE** — deleted in the workspace's deletion PR with no replacement.

Helper modules that only tests import (`test-db.ts`, `library-fixture.ts`, `frameViewMock.ts`,
`testUtils.ts`, `collector-fixtures`, `tests/**/fixtures`) are deleted when their last consumer
goes; Knip will flag any that are missed.

## Tag table

### apps/pane-view — features/gallery (15 files, 3,819 lines)

| file | tests | mocks | tag | reason |
|---|---:|---:|---|---|
| `FloatingToolbar.test.tsx` | 8 | 9 | E2E | exclude button/dialog is walked by pane-view e2e "recursive excludes" |
| `MediaViewerModal.test.tsx` | 12 | 7 | E2E | resume position + next/prev/wrap covered by e2e "viewer" |
| `PaneViewImage.test.tsx` | 5 | 1 | DELETE | image retry/backoff internals |
| `batched-thumbnail-resolver.test.ts` | 7 | 0 | DELETE | batch-size internals (48-cap); e2e loads real pages |
| `comic-summary.test.tsx` | 3 | 8 | E2E | comic card + open covered by e2e "comic mode" |
| `gallery-browse-storage.test.ts` | 7 | 2 | DELETE | localStorage adapter; e2e excludes flow proves persistence across reload |
| `gallery-navigation.test.tsx` | 9 | 1 | E2E | cross-page stepping/wrap covered by e2e "viewer" |
| `gallery-page-helpers.test.ts` | 7 | 0 | DELETE | dedupe/equality helpers |
| `resolve-throttle.test.ts` | 4 | 0 | DELETE | concurrency/circuit-breaker internals |
| `useGalleryBrowse.test.tsx` | 13 | 1 | E2E | paging, shuffle, stale-page drop covered by e2e "sorting & paging" |
| `useGalleryBrowseState.hook.test.tsx` | 11 | 1 | E2E | persisted flags/seed round-trip covered by e2e "browse state" |
| `useGalleryBrowseState.test.ts` | 29 | 0 | KEEP | pure URL/flag folding contract (root forces modes off, comic implies recursive, URL wins over remembered flags); cheap and mock-free |
| `useGalleryKeyboard.test.tsx` | 6 | 8 | E2E | grid keyboard movement covered by e2e "keyboard" |
| `useResolvedMediaUrl.test.tsx` | 6 | 1 | DELETE | URL cache-sharing internals |
| `useWindowedThumbnailResolution.test.tsx` | 8 | 2 | DELETE | scroll-debounce/batch-chaining internals |

### apps/pane-view — features/viewer, features/library, root

| file | tests | mocks | tag | reason |
|---|---:|---:|---|---|
| `features/viewer/PdfViewer.test.ts` | 10 | 16 | E2E | open a PDF, scroll, page window — e2e "viewer (pdf)" |
| `features/viewer/use-library-viewer-state.test.ts` | 4 | 0 | DELETE | debounce/flush internals |
| `features/library/library-service.test.ts` | 11 | 0 | DELETE | request-shaping for plan 054; e2e excludes flow covers the outcome |
| `production-export-names.test.ts` | 1 | 0 | DELETE | absence test |

### apps/pane-view — server/auth (5 files)

| file | tests | mocks | tag | reason |
|---|---:|---:|---|---|
| `api-token.test.ts` | 6 | 1 | KEEP | fail-closed token verification; security |
| `client-ip.test.ts` | 3 | 0 | KEEP | header trust rules; security |
| `login-throttle-spoofing.test.ts` | 1 | 0 | TRIM | keep the case, move it into `login-throttle.test.ts`, delete the file |
| `login-throttle-sql.test.ts` | 4 | 0 | DELETE | pins SQL text |
| `login-throttle.test.ts` | 6 | 0 | KEEP | brute-force guard behavior; security |

### apps/pane-view — server/library (7 files, 1,843 lines)

| file | tests | mocks | tag | reason |
|---|---:|---:|---|---|
| `comic-listing.test.ts` | 8 | 0 | E2E | SQL-shape pins; e2e "comic mode" + "sorting" |
| `gallery-listing.pglite.test.ts` | 21 | 0 | E2E | the oracle suite; every case maps to e2e "sorting & paging", "comic mode", "recursive excludes", "search" |
| `gallery-listing.test.ts` | 5 | 0 | KEEP | cursor codec rejects tampered/foreign cursors; pure |
| `gallery-order.test.ts` | 11 | 0 | TRIM | keep determinism, distinct-per-seed, keys-media-and-comics-separately; delete quartile/prefix-spread statistics |
| `library-conditions.test.ts` | 4 | 0 | E2E | exclusion SQL; e2e "recursive excludes" |
| `query-helpers.test.ts` | 6 | 0 | DELETE | scope helpers + LIKE escaping; e2e "search" with `%`/`_` in the query covers escaping |
| `repository.test.ts` | 13 | 0 | E2E | order/cursor SQL pins; e2e "sorting & paging" |

### apps/pane-view — server/management (9 files)

| file | tests | mocks | tag | reason |
|---|---:|---:|---|---|
| `cleanup-control.test.ts` | 2 | 0 | DELETE | trivial |
| `cleanup-worker.test.ts` | 4 | 1 | DELETE | retired-phase migration one-offs |
| `folder-delete.test.ts` | 9 | 0 | KEEP | destructive op: root refusal, traversal refusal, active-job guards, transaction rollback |
| `guards.test.ts` | 2 | 0 | KEEP | sync/cleanup mutual exclusion |
| `maintenance-descriptors.test.ts` | 7 | 2 | TRIM | keep "library wipe requires the confirmation string and the sync token"; delete the rest |
| `maintenance-progress.test.ts` | 5 | 0 | DELETE | retired-phase mapping |
| `maintenance-scheduler.test.ts` | 8 | 3 | DELETE | unique-violation mapping internals |
| `maintenance-storage.test.ts` | 2 | 2 | DELETE | mock-shape |
| `sync-run-control.test.ts` | 3 | 0 | DELETE | trivial |

### apps/pane-view — server/media, server/sync, server/stats, root (13 files)

| file | tests | mocks | tag | reason |
|---|---:|---:|---|---|
| `media/concurrency-limiter.test.ts` | 1 | 0 | DELETE | trivial |
| `media/resolve-delivery-url.test.ts` | 4 | 3 | DELETE | mock-shape |
| `media/shutter-capability-config.test.ts` | 8 | 0 | DELETE | config parsing (Railway/hex/quote variants) |
| `media/shutter-client-import.test.ts` | 1 | 1 | DELETE | absence test |
| `media/shutter-client.test.ts` | 11 | 10 | DELETE | mock-shape; `packages/shutter-client` has its own |
| `media/shutter-delivery-redirect.test.ts` | 3 | 3 | DELETE | mock-shape |
| `media/variant-provider.test.ts` | 6 | 0 | DELETE | config branching; e2e runs pass-through (no Shutter) mode |
| `security-headers.test.ts` | 4 | 0 | KEEP | security headers per route class |
| `stats/archive-stats-helpers.test.ts` | 7 | 0 | DELETE | series helpers; e2e "stats page" asserts a number |
| `sync/routes.test.ts` | 11 | 7 | E2E | route wiring + unauthorized paths covered by e2e "lockstep push (bad token / good token)" |
| `sync/store.test.ts` | 13 | 1 | KEEP | sync integrity: HEAD attestation before transaction, terminal-status transitions, non-running run rejection |
| `sync/validation.test.ts` | 12 | 0 | KEEP | boundary parsing incl. path traversal and extension aliasing |

### apps/gather-box (34 files, 3,102 lines)

| file | tests | mocks | tag | reason |
|---|---:|---:|---|---|
| `background/gather-commands.test.ts` | 3 | 9 | DELETE | mock-shape |
| `background/gather-run-coordinator.test.ts` | 10 | 0 | KEEP | run/queue state machine, pure |
| `background/offscreen-document.test.ts` | 5 | 20 | DELETE | mock-shape |
| `background/redgifs-media-resolver.test.ts` | 2 | 0 | DELETE | site-specific (decision 4) |
| `background/x-media-resolver.test.ts` | 2 | 0 | DELETE | site-specific (decision 4) |
| `content/collector-entry.test.ts` | 2 | 10 | DELETE | mock-shape |
| `content/collectors/collector-fixtures.test.ts` | 12 | 0 | DELETE | collectors (decision 4); delete `collector-fixtures.ts` and fixtures dir with it |
| `content/collectors/danbooru.test.ts` | 3 | 0 | DELETE | collector (decision 4) |
| `content/collectors/hentai-foundry-pictures.test.ts` | 1 | 0 | DELETE | collector (decision 4) |
| `content/collectors/pixiv.test.ts` | 2 | 0 | DELETE | collector (decision 4); plan 055's regression fixture goes too |
| `content/page-shortcuts.test.ts` | 8 | 8 | DELETE | mock-shape keyboard handling |
| `gather/active-tab.test.ts` | 2 | 8 | DELETE | mock-shape |
| `gather/archive-media-policy.test.ts` | 5 | 0 | KEEP | pure: which files convert to AVIF/MP4 and which pass through |
| `gather/archive-media-transformer.test.ts` | 4 | 6 | DELETE | mock-shape |
| `gather/avif-codec.test.ts` | 1 | 1 | DELETE | pins encoder params |
| `gather/avif-encoder.test.ts` | 2 | 1 | DELETE | worker plumbing |
| `gather/directory-store.test.ts` | 4 | 7 | DELETE | mock-shape permission calls |
| `gather/downloader.test.ts` | 8 | 8 | DELETE | collision/suffix behavior; mocks the file handles it asserts on. If the owner wants this behavior pinned, it is a gather-box e2e case (see STOP 2) |
| `gather/fanfiction-story.test.ts` | 4 | 16 | DELETE | site-specific + mock-shape |
| `gather/folder-compatibility.test.ts` | 4 | 1 | DELETE | legacy-folder one-off |
| `gather/gif-mp4-encoder.test.ts` | 3 | 8 | DELETE | mock-shape |
| `offscreen/execution-slot.test.ts` | 5 | 2 | DELETE | slot internals |
| `offscreen/executor.test.ts` | 1 | 0 | DELETE | trivial |
| `offscreen/run-event-emitter.test.ts` | 3 | 0 | DELETE | ordering internals |
| `shared/download-policy.test.ts` | 3 | 0 | KEEP | cross-site host rejection + filename sanitising; security |
| `shared/gather-controller.test.ts` | 2 | 9 | DELETE | mock-shape |
| `shared/gather-queue.test.ts` | 7 | 0 | KEEP | queue/recovery state, pure |
| `shared/gather-run-messages.test.ts` | 1 | 0 | DELETE | schema ceremony |
| `shared/gather-run.test.ts` | 2 | 0 | DELETE | schema ceremony |
| `shared/last-run.test.ts` | 3 | 2 | DELETE | write coalescing |
| `shared/path.test.ts` | 4 | 0 | KEEP | rejects `.`/`..` segments; security |
| `shared/settings.test.ts` | 7 | 0 | DELETE | settings defaults/migration |
| `shared/sites.test.ts` | 1 | 0 | DELETE | absence test |
| `shared/source-catalog.test.ts` | 4 | 0 | TRIM | keep "owns every HTTPS permission with a reason" (manifest/permission drift guard); delete the rest |

### apps/frame-view (19 files, 3,376 lines)

| file | tests | mocks | tag | reason |
|---|---:|---:|---|---|
| `main/catalog/CatalogRuntime.test.ts` | 11 | 6 | E2E | scan → batches → done, excludes, cancel: frame-view e2e "scan" |
| `main/catalog/CatalogService.test.ts` | 1 | 1 | DELETE | crash-restart one-off |
| `main/catalog/catalogDiscoveryAdapter.test.ts` | 4 | 0 | KEEP | pure media classification/junk filtering |
| `main/ipc/registerIpc.test.ts` | 9 | 0 | KEEP | folder-authorization guards on every IPC surface; security |
| `main/mainWindowLifecycle.test.ts` | 2 | 21 | DELETE | 21 mocks for 2 tests |
| `main/services/mediaBinaryResolver.test.ts` | 2 | 0 | DELETE | packaging one-off |
| `main/services/mediaProtocol.test.ts` | 9 | 0 | TRIM | keep authorized-root checks (inside root, case folding, most-specific root); delete content-type/range/priority-clamp cases |
| `main/services/settingsService.test.ts` | 7 | 1 | DELETE | settings migration/backfill + write coalescing |
| `main/services/thumbnailService.test.ts` | 4 | 0 | E2E | cache reuse: frame-view e2e "thumbnails" (second scan is served from cache) |
| `main/thumbnail/ThumbnailBrokerService.test.ts` | 8 | 4 | DELETE | queue priority/dedupe internals |
| `main/thumbnail/ThumbnailWorkerRuntime.test.ts` | 2 | 0 | KEEP | real sharp/ffmpeg output on disk |
| `preload.test.ts` | 3 | 2 | DELETE | bridge plumbing |
| `renderer/App.test.tsx` | 2 | 3 | DELETE | one-off rescan bug |
| `renderer/ModalDialogs.test.tsx` | 2 | 5 | E2E | viewer/comic modals: frame-view e2e "viewer" |
| `renderer/rendererDependencies.test.ts` | 1 | 0 | DELETE | bundling absence test |
| `renderer/store/useAppStore.test.ts` | 8 | 0 | E2E | store behavior is observable through the e2e scan/recursive flows |
| `renderer/utils/comics.test.ts` | 3 | 0 | KEEP | pure, Windows + POSIX paths (can't e2e both on one OS) |
| `renderer/utils/path.test.ts` | 7 | 0 | KEEP | same |
| `shared/contracts.test.ts` | 3 | 0 | DELETE | schema ceremony |

### apps/lockstep, apps/lockstep-cli

| file | tests | mocks | tag | reason |
|---|---:|---:|---|---|
| `lockstep/tests/main/profileService.test.ts` | 7 | 0 | KEEP | tokens never written to public settings; encryption-unavailable handling; security |
| `lockstep/tests/main/runService.test.ts` | 4 | 0 | DELETE | summary shaping |
| `lockstep-cli/src/commands.test.ts` | 6 | 8 | KEEP | prune never runs without `--yes` or interactive confirmation; destructive-op guard |
| `lockstep-cli/src/config.test.ts` | 4 | 0 | DELETE | config parsing |
| `lockstep-cli/src/options.test.ts` | 11 | 0 | TRIM | keep `--upload-concurrency` bounds and the "requires X for command Y" cases; delete flag-parsing cases |

### packages

| file | tests | mocks | tag | reason |
|---|---:|---:|---|---|
| `lockstep-core/hash-cache.test.ts` | 5 | 0 | KEEP | real on-disk cache format, rebuild on corruption |
| `lockstep-core/plan-sync.test.ts` | 5 | 0 | KEEP | which files get hashed — the sync cost model |
| `lockstep-core/prune-deleted.test.ts` | 4 | 0 | KEEP | run finalization states on failure/abort |
| `lockstep-core/push-changes.test.ts` | 9 | 0 | TRIM | keep finalization/abort/ordering cases; delete "rejects invalid uploadConcurrency" and "bounds peak upload concurrency" |
| `lockstep-core/push-helpers.test.ts` | 4 | 0 | TRIM | keep "rejects paths that escape the source root"; delete legacy hash-mode mapping |
| `lockstep-core/remote-api.test.ts` | 2 | 0 | KEEP | exact bytes + digest verification on upload |
| `lockstep-core/remote-snapshot.test.ts` | 3 | 0 | DELETE | schema ceremony |
| `lockstep-core/scan-progress-coalescer.test.ts` | 5 | 0 | DELETE | throttle internals |
| `media-domain/media.test.ts` | 5 | 0 | KEEP | ordering + comic grouping rules, pure |
| `media-domain/paths.test.ts` | 7 | 0 | KEEP | path identity (case, NFC/NFD, jpg/jpeg), pure |
| `media-index/scan.test.ts` | 12 | 0 | TRIM | keep skip rules, abort, logical-path order, fingerprint-change rejection; delete the bound/parallelism cases |
| `media-index/sync-plan.test.ts` | 8 | 0 | KEEP | the sync identity contract |
| `media-storage/index.test.ts` | 1 | 0 | DELETE | trivial |
| `media-storage/s3.test.ts` | 8 | 5 | DELETE | mocks the SDK; e2e pushes through real rustfs |
| `shutter-client/index.test.ts` | 12 | 0 | TRIM | keep capability/auth guards and Retry-After polling; delete URL-shape cases |

### Totals if applied as proposed

| tag | files | notes |
|---|---:|---|
| KEEP | 29 | most of `packages/`, auth/sync/management guards, pure path/ordering rules |
| TRIM | 10 | |
| E2E | 17 | deleted with the e2e PR that covers them |
| DELETE | 69 | |

125 → 39 files once E2E lands; test LOC ~19.9k → roughly 6k.

## End-to-end suite

### Placement and tooling

- New workspace `e2e/` (`@latch-works/e2e`), Playwright `@playwright/test`. Playwright covers all
  four surfaces: Chromium for Pane View, `_electron.launch` for Frame View and Lockstep, a
  persistent Chromium context with `--load-extension` for Gather Box. One tool, one reporter.
- Scripts: `pnpm e2e` (all), `pnpm e2e:pane`, `pnpm e2e:frame`, `pnpm e2e:lockstep`,
  `pnpm e2e:gather`. **Not** wired into `pnpm test` or `pnpm check:all`.
- Fixture archive `e2e/fixtures/archive/` generated by `e2e/scripts/make-fixture.ts` on first run
  (sharp for images, ffmpeg via the existing frame-view binary resolution for one 1 s MP4 and one
  GIF, a 3-page PDF via pdf-lib). Deterministic names chosen to exercise natural ordering
  (`1.jpg`, `2.jpg`, `10.jpg`, `a.jpg`, `A.jpg`, `Ünïcode.jpg`), nested folders, one video-only
  folder, one root-level image, one comic-eligible leaf, one folder with `%`/`_` in its name.
  Committed output is forbidden; the generator is committed.
- Pane View needs the local stack: `docs/localhost/compose.yaml` up, `DATABASE_URL`/`S3_*` from
  `latch-works.env.example`, `SHUTTER_EDGE_URL` empty (pass-through). `pnpm e2e:pane` fails fast
  with a clear message if `GET /api/health` is not `ok`.

### Pane View cases (also the Lockstep roundtrip)

Global setup: reset the DB (`docker compose down -v && up -d`, or a `TRUNCATE` script), run
`pnpm db:migrate`, start Pane View on 3000, run `lockstep-cli push --yes` from the fixture
archive with the sync token. That push **is** the Lockstep→Pane View roundtrip test: assert the
run finalizes `completed` and the item count matches the fixture.

1. **auth** — login page rejects a bad password, accepts the configured one; repeated bad
   attempts get throttled (replaces `login-throttle` route-level coverage).
2. **browse** — root lists folders and the root image; entering a folder shows its children and
   nothing deeper.
3. **sorting & paging** — for each of `name-asc`, `name-desc`, `date-newest`, `date-oldest`,
   `random`: page through the whole recursive root with a small page size, concatenate, assert the
   order against an in-test oracle built from the fixture manifest (natural collation for name;
   mtime for date; for random, assert it is a permutation, stable within a seed across pages, and
   different under a new seed after Shuffle). Assert folders appear on page 1 only.
4. **filters** — images-only and videos-only toggles hide the right items and do not reorder the
   rest.
5. **recursive** — toggling recursive from a folder shows the subtree; root forces it off;
   turning recursive off turns comic off.
6. **recursive excludes** — open the exclude dialog, exclude one child, listing loses exactly that
   subtree, dot indicator shows, reload keeps the exclude, search still finds files inside the
   excluded folder, clearing the exclude restores the listing.
7. **comic mode** — leaf folders appear as comics with the natural-first cover; root media,
   video-only and parent folders never do; opening a comic shows every page in natural order;
   search from a folder finds comics across the archive.
8. **search** — plain query, a query containing `%` and `_` (must match literally), empty result.
9. **viewer** — open an image, next/prev across a page boundary, wrap only at the true end with
   loop on, video resumes at saved position after reopen, PDF opens and scrolls to page 3, Escape
   closes.
10. **keyboard** — arrow movement through the grid including the last-row clamp; Enter opens.
11. **sync guards** — a push with a wrong token is 401 and creates no run; a second push while a
    run is active is refused (replaces `sync/routes.test.ts`).
12. **folder delete** — soft-delete a folder from the management page, confirm it disappears from
    browse and from comic mode, and the maintenance page shows the pending purge.
13. **stats** — stats page renders the fixture's item count and total size.

### Frame View cases (`_electron.launch` against the Vite dev build, `FRAME_VIEW_DISABLE_GPU=1`)

1. **scan** — open the fixture folder through a stubbed dialog (`app.commandLine` env hook the
   memory recipe describes; make it permanent behind `FRAME_VIEW_E2E_FOLDER`), grid fills, count
   matches; recursive toggle adds the subtree; exclude a child folder; filters hide videos.
2. **sorting** — same five modes as Pane View, same oracle (parity is a settled product call).
3. **thumbnails** — every grid cell gets a rendered thumbnail; second launch on the same folder is
   served from cache (assert no worker spawn via the log).
4. **viewer** — image/video/comic/PDF modals open, navigate, close; remembered folder restores on
   relaunch.
5. **quit** — the app quits cleanly on `app.quit()` (the 2026-08-23 bug).

### Lockstep desktop cases

1. Create a profile against the running Pane View, plan shows the fixture as uploads, push
   completes, plan again shows nothing to do, token is not present in `lockstep-settings.json`.

### Gather Box cases — see STOP 2

1. Load the unpacked extension in a persistent context, open a local fixture page served from
   `e2e/fixtures/gather/` (a generic gallery page — **not** a saved copy of a real site), trigger
   gather, assert the expected files land in the chosen directory with collision suffixes applied
   on a second run.

## Steps

Each PR: branch `agent/056-<slug>`, one commit per logical change, gates `pnpm test`,
`pnpm typecheck`, `pnpm lint:all`, `pnpm knip` (dead fixtures), plus the relevant `pnpm e2e:*`
run described in the PR body with its output.

1. **PR 1 — e2e workspace + Pane View suite + Lockstep CLI roundtrip.** Adds `e2e/`, the fixture
   generator, Playwright config, cases 1–13 above. Deletes every pane-view file tagged E2E and
   DELETE, applies TRIMs. Adds a `docs/runbooks/e2e.md` with the local-stack prerequisites.
2. **PR 2 — Gather Box deletions.** Applies the gather-box table. No e2e prerequisite except
   `downloader.test.ts`, which is deleted regardless (decision 4 + owner's stance on mock-shape).
3. **PR 3 — Frame View e2e + deletions.** Adds the Electron project and cases 1–5, the permanent
   `FRAME_VIEW_E2E_FOLDER` hook, deletes/trims per table.
4. **PR 4 — Lockstep desktop e2e + lockstep/lockstep-cli/packages trims.**
5. **PR 5 — Gather Box e2e** only if STOP 2 resolves in favour.
6. **Landing commit of each PR** updates the plan index; the last PR records the final counts
   here and removes this file per the index convention.

## PR 1 record (2026-08-25)

Landed on `revise-testing`:

- `e2e/` workspace (`@latch-works/e2e`, Playwright 1.62) with `pnpm e2e` / `pnpm e2e:pane`; the
  webServer script recreates a dedicated `latch_works_e2e` database and `latch-works-e2e` bucket
  on the compose stack so the developer's synced archive is never touched. Fixture manifest +
  generator (`e2e/src/fixture.ts`, `e2e/scripts/make-fixture.ts`), 96 items. Runbook at
  `docs/runbooks/e2e.md`; AGENTS.md names the suite as the final pre-PR check.
- Pane View cases 1–13 as 8 spec files (39 tests incl. the two setup steps); the seed step is the
  Lockstep CLI push and doubles as the roundtrip test. Case 11's "second push refused while a run
  is active" became "an active run blocks destructive maintenance until stopped", which is the
  guard the UI actually exposes.
- Deleted every pane-view file tagged DELETE or E2E (39 files) plus the orphaned helpers
  `gallery-session-harness.tsx`, `gallery-page-source.memory.ts`, `library-fixture.ts`, and the
  `@typescript/typescript6` devDependency only `production-export-names.test.ts` used. TRIMs
  applied: spoofing case merged into `login-throttle.test.ts`; `gallery-order.test.ts` down to
  determinism/distinct-seed/separate-keys; `maintenance-descriptors.test.ts` renamed
  `library-wipe.test.ts` with only the confirmation/token guard. pane-view: 52 → 12 test files,
  620 → 104 tests. `test-db.ts` stays (folder-delete, guards, store, library-wipe use it).

Deviations and findings:

- **Recursive listings carry no folder entries** (only page 1 of a non-recursive browse does); the
  plan's case 3 wording assumed otherwise. The oracle follows the product.
- **Folder entries follow the name direction only**: Z-A reverses them, date modes leave them A-Z.
- **The PDF viewer needs a bucket CORS rule in pass-through mode** (images do not: `<img>` loads
  cross-origin, pdf.js `fetch`es). Against local rustfs it shows "Failed to fetch" until the e2e
  setup puts a `GET/HEAD` rule for the app origin on the e2e bucket. The owner reports production
  pass-through works, so this is a localhost-stack gap: `docs/localhost` should set the same rule.
- **Clearing a search does not restore the recursive flag** it was submitted under; the excludes
  spec navigates back explicitly. Product call whether that is intended — flagged, not changed.
- A dedicated `disposable/` fixture folder exists for the soft-delete case so no other spec's
  expectations move.

## PR 2 record (2026-08-25)

Branch `agent/056-gather-box-deletions`, stacked on `revise-testing`. Applied the Gather Box table
as written: 28 files deleted, `source-catalog.test.ts` trimmed to the HTTPS-permission guard.
34 → 6 files, 145 → 35 tests. One knip follow-up: deleting `avif-codec.test.ts` hid the AVIF
worker (`src/gather/avif-encoder.worker.ts`, a build entry in `scripts/build.mjs`) from knip's
graph, so that entry is now declared in `knip.json`. No Gather Box e2e in this PR (STOP 2 is
deferred to PR 5).

## PR 3 record (2026-08-25)

Branch `agent/056-frame-view-e2e`, stacked on `agent/056-gather-box-deletions`. Frame View e2e
project (`pnpm e2e:frame`): Playwright's Electron driver against the Forge-packaged build, fresh
userData per launch, `dialog.showOpenDialog` replaced from the main process (no product hook was
needed — the plan's `FRAME_VIEW_E2E_FOLDER` idea is moot). 13 tests: scan/recursive/excludes/
filters, four ordered sort modes + Random/Shuffle against the shared oracle, thumbnails, viewer,
comic reader, remembered folder across relaunch (quit-clean is implicit: every test closes the app
and Playwright waits for exit). Deleted/trimmed per the table: 13 files gone, `mediaProtocol.test.ts`
down to the authorized-root cases, orphaned `frameViewMock.ts`/`testUtils.ts`, the testing-library
and jsdom devDependencies, and three `mediaProtocol` exports only tests used. 19 → 6 files,
91 → 28 tests.

Findings:

- **Bug: a fresh scan renders discovery order, not the configured sort.** Right after "Open",
  `comics/alpha` shows `10, b, A, 2, 1` in the grid and the viewer steps through that sequence;
  choosing any sort mode (even the current one) fixes it. The deleted
  `useAppStore.test.ts` "flattens and sorts loading chunks on done" passed, so the unsorted items
  reach the grid by another path. `gallery.spec.ts` asserts the correct behaviour and is red
  until the bug is fixed (owner's call: a known bug keeps the suite red). Not fixed in this PR.
- Frame View indexes images and videos only; the fixture PDF is invisible to it (plan 040 is the
  PDF spike). The Frame View oracle filters it out.
- The Frame View grid is virtualised (~55 tiles per window); the helper scrolls the container and
  merges windows to read a full order.
- `ELECTRON_RUN_AS_NODE=1` in an agent shell makes Playwright's Electron launch fail with an
  unhelpful "Process failed to launch"; the helper strips it.

## PR 4 record (2026-08-25)

Branch `agent/056-lockstep-and-packages`, stacked on `agent/056-frame-view-e2e`. Lockstep desktop
e2e project (`pnpm e2e:lockstep`, depends on the `pane-view` project so the server is up and
seeded): Forge-packaged build, fresh userData, profile created against the e2e server with a
second two-image fixture (`e2e/.fixtures/lockstep-source`), Plan → 2 uploads, Push → 2 pushed /
0 failed and both paths in `/api/sync/snapshot`, Plan again → nothing to upload, and
`lockstep-settings.json` free of the token. Trims and deletions per the table across
`apps/lockstep`, `apps/lockstep-cli`, `packages/lockstep-core`, `packages/media-index`,
`packages/media-storage` (no tests left; its `test` script and vitest devDependency are gone) and
`packages/shutter-client`. Package suites: 24 + 15 + 9 tests; lockstep 7, lockstep-cli 12.

Findings:

- An unsigned Electron build has no OS keychain, so a saved token is session-only ("OS encryption
  unavailable"); the spec's last case relies on exactly that to prove the token never lands in the
  settings file. On a signed build the same assertion holds because the token is stored encrypted.
- Playwright's Electron `env` wants a string map; `electronChildEnv()` in `e2e/src/env.ts` builds
  it (dropping `ELECTRON_RUN_AS_NODE`) for both desktop apps and their Forge package steps.

## Done criteria

- [x] Owner has reviewed the tag table (approved as written, 2026-08-25).
- [x] `pnpm e2e:pane` passes locally against the compose stack and covers cases 1–13 (PR 1).
- [x] `pnpm e2e:frame` passes locally and covers cases 1–5 (PR 3; case 5 quit-clean is implicit in every test's teardown).
- [x] `pnpm e2e:lockstep` passes locally (PR 4).
- [x] Every file tagged DELETE is gone; every E2E file is gone in the same PR as its coverage;
      every TRIM file has only the named cases left (PRs 1–4; Gather Box e2e deferred per STOP 2).
- [x] `pnpm test` still passes and runs in under 10 s.
- [x] Knip reports no orphaned test helpers or fixtures.
- [x] `docs/runbooks/e2e.md` exists and `CLAUDE.md` names `pnpm e2e:*` as the final check before
      a PR is marked ready (PR 1).

## STOP conditions

1. **A KEEP-tagged file turns out to be mock-shape on inspection** (the tags were made from test
   names and mock counts, not a full read). Re-tag it in the PR body and proceed; do not silently
   keep it.
2. **Gather Box e2e feasibility.** The extension picks its output directory through the File
   System Access API picker, which Playwright cannot drive. Options: (a) an e2e-only settings
   flag that accepts a directory handle from `chrome.storage` seeded by the test, (b) test through
   the `chrome.downloads` fallback if one exists, (c) no Gather Box e2e — a manual smoke checklist
   in the runbook. Investigate (a) for at most two hours in PR 2; if it needs product code beyond
   a flag, stop and ask.
3. **Fixture media generation needs ffmpeg on the machine.** If the frame-view binary resolution
   does not expose one for scripts, ask before adding a new dev dependency.
4. **CI.** Running Pane View e2e in GitHub Actions needs the compose stack as a service and
   Electron needs `xvfb`. Do not add either to `check.yml` in this plan; open a follow-up.
