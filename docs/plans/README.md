# Improvement plan index

Plans 024–040 were generated from the deep repository survey at commit `fd5693d` on 2026-07-13;
plans 041–045 from the Gather Box architecture review on 2026-07-15; plans 046–047 from the
open-sourcing test audit on 2026-07-27; plans 048–050 from the Pane View architecture review at
commit `7076ce8` on 2026-08-14; plans 051–052 from the Pane View gallery pagination investigation at
commit `bf8b0c8` on 2026-08-15 (split into server and client halves at `c8f46f4` on 2026-08-16);
plan 053 from the two-axis review of PR #98 at merge commit `d99af8e` on 2026-08-21.
Every open plan is written for an implementation agent and
begins with a drift check. Status changes belong in this index and the corresponding plan.

Last audited 2026-08-17 at commit `4ae457e` (plan 025 landed the same day; 037 rejected; 050 folded
into 051; product-owner decisions recorded in 040, 048, 051, 052). Completed plan files are removed
once their outcome is recorded below; recover full text with `git log --diff-filter=D --follow -- docs/plans/<file>`.

## Open work

| Plan | Outcome | Priority | Effort | Depends on | Status |
|---|---|---:|---:|---|---|
| [040](040-frame-view-pdf-spike.md) | Validate and specify Frame PDF reading by porting Pane's windowed viewer | P2 | M spike | 033, 034 (both done) | TODO (Steps 2–3 need the product owner at a desktop) |
| [053](053-gallery-waterfall-review-followups.md) | Land the five review follow-ups from PR #98: debounce edge, resolver rejection test, staleness dedupe, naming, `library` off the session | P3 | S | PR #98 (merged) | TODO |

Recommended order (2026-08-17 review):

1. **048 and 051** — implemented as the bottom two PRs of the 2026-08-17 stack:
   `agent/051-gallery-server-order` (PR #79) then `agent/048-gallery-browse-state` (PR #80,
   reuses 051's `createGalleryRandomSeed`).
2. **052** after both — `agent/052-gallery-browse-session` (PR #82), third in the stack.
3. **049** after 051 — `agent/049-maintenance-scheduler` (PR #83), top of the stack; its worker
   and descriptor tests use 051's pglite harness.
4. **040** whenever the product owner has an hour at a desktop for Steps 2–3; the agent-side steps
   can start any time.

Decisions already taken by the product owner (do not re-ask; STOP conditions referring to them are
resolved): root preferences stay and will grow a per-root recursive-exclusion list in a future plan
(048); server ordering uses a natural, case-insensitive ICU collation, not byte order (051);
backward navigation stays put on the first item until every page is loaded, and comic Delete is
dropped from the gallery for now (052); Frame PDF reading is wanted and should port Pane's viewer
(040); Plan 037 is rejected without measurement (below).

Nothing is blocked on environment any more: Plan 025 landed, Docker (OrbStack) is available locally
for disposable PostgreSQL, and `drizzle-kit generate` produces correct migrations again.

## Execution blockers

None on environment. Plan 040's Steps 2–3 (packaged Electron smoke, latency and canvas measurements)
need a person at a desktop; everything else in every open plan is agent-executable.

### Lost branches — both referenced work branches are gone

The previous index told executors to continue from `codex/026-attest-sync-uploads` at `2dcf74e` and
`codex/040-frame-view-pdf-spike` at `b74d7b8`. Neither branch exists locally or on `origin`, and
neither commit is reachable from any ref — they survive only as dangling objects in this clone and
will disappear on `git gc`. They are unrecoverable from a fresh clone.

This cost nothing for 026, whose work was redone and landed on `main` (see below). For 040 the lost
commit was a provisional design record only; no prototype, measurements, or worker-resolution
evidence ever existed, so re-running the spike loses nothing but the writing. Future plans should
push work branches to `origin` before recording them as the continuation point.

## Completed work

Two-sentence outcomes. The plan files are deleted; the landing commit is the record.

| Plan | Commit | Outcome |
|---|---|---|
| 024 | `4cc6141` | Root `pnpm lint` walked the ignored `.pnpm-store` and emitted thousands of third-party diagnostics on any checkout with a local pnpm store. Biome's explicit traversal now excludes it, with a regression check that does not blanket-hide dot-directories. |
| 025 | `1dc87b1` | Drizzle's newest snapshot was `0006`, still modelling the removed `thumbnails` table, while hand-written migrations `0007`–`0016` had moved the schema on; the generator was unusable and needed a TTY to answer rename-vs-create prompts. `0017_schema_baseline` now carries a current snapshot with a comments-only body — except one live `SET DEFAULT` that corrected genuine drift (`maintenance_jobs.progress` still defaulted to `s3_derivatives`) — verified equivalent on fresh and through-`0016` Postgres 16 containers, after which `db:generate` reports no changes. |
| 026 | `458cda2` | Pane View derived object keys from a claimed SHA-256 without binding upload size or checksum, and registered client metadata without asking S3 what it actually stored. Uploads are now size-bounded, presigned with signed checksum/length headers using `unhoistableHeaders`, hashed in-flight by Lockstep, and HEAD-verified against storage before any database row is written. |
| 027 | `13eda05` | Client finalization updated sync runs by ID alone and could overwrite a `cancelled` run with `completed` or `failed`. Terminal states are now monotonic while exact replay of a recorded completion stays safe. |
| 028 | `3eb65e4` | The thumbnail resolver sent only the first 48 visible requests and never scheduled the rest once those resolved terminally. The client now drains successive bounded batches without raising the server's documented 48-item maximum. |
| 029 | `e81477c` | Folder subtree deletion updated entries and folders in separate un-transacted statements per selected root, so an error could leave the hierarchy half-deleted. The whole user action now commits atomically or touches nothing. |
| 030 | `5885249` | Sync startup and hard-wipe scheduling did independent check-then-act queries, so concurrent requests could both pass and let uploads run while destructive cleanup deleted the library. Both paths now take one PostgreSQL advisory transaction lock, wipe scheduling is atomic with its job insert, and a partial unique index permits at most one active hard wipe. |
| 031 | `969a9fa` | A failed media-index batch still called `finishScan`, deleting rows not tagged with the new scan ID and reporting success — a transient write failure could destroy valid index coverage. Durable scan finalization now aborts and retains the previous committed index. |
| 032 | `7e968e3` | Every Gather Box log append started an unawaited whole-object write, so older saves could land after newer retry state and silently drop retry availability. Writes are now serialized and coalesced with an explicit flush for terminal download state. |
| 033 | `30fb5e4` | Frame View kept diverging copies of shared sorting, hashing, comic grouping, and path normalization — Frame rejected GIF comic pages that `media-domain` accepted. Shared archive behavior moved into `@latch-works/media-domain` with Frame's absolute-path policy behind explicit adapters. |
| 034 | `a996635` | Opening a PDF rendered every full-resolution page sequentially and retained all of them, delaying first interaction and repainting fully on resize. The viewer now lays out cheap page geometry immediately and renders only the visible window plus bounded overscan, capped at eight live canvases. |
| 035 | `5baae31` | Archive traversal awaited every child directory, stat, and full file hash in one serial chain, underusing disks on large or networked archives. Bounded pools now parallelize the latency while keeping results deterministic and cancellation prompt. |
| 036 | `5e69cba` | Lockstep pushed one item at a time through hash, upload-target, PUT, and registration, paying full network latency per file. Pushes now run through a bounded queue with a validated `uploadConcurrency` (default 3, range 1–8) and a matching `--upload-concurrency` CLI flag, preserving item ordinals and cancellation. |
| 038 | `c63b42f` | Comic-mode snapshots refetched the entire active folder tree on every 500-media "load more", and `GalleryPage` discarded it. The tree is now fetched once per browse key and explicitly omitted from subsequent pages. |
| 039 | `953e7b2` | Onboarding docs described removed packages, obsolete CLI syntax, and a retired Pane-owned derivative pipeline, and the Showcase promised a Frame PDF reader that does not exist. Docs now match Shutter and the current scripts, and Frame PDF is labelled planned everywhere. |
| 041 | `c1b5b41` | `GatherController` ran collection, fetches, writes, PDF generation, retries, and persistence inside whichever UI surface constructed it, so popup focus loss destroyed the running document and multiple pages could duplicate work. A Gather Run now has one owner whose lifetime is independent of any UI surface. |
| 042 | `a446928` | Native commands, page keys, context menus, popup keys, and side-panel keys each routed through different paths, racing a global pending boolean against broadcasts and UI opening. Commands are now exact and side-panel-only, with target identity carried in the message that starts a download. |
| 043 | `6125700` | Each popup/side-panel bundle was ~2.27 MB, of which 2.19 MB (96.5%) was PDF-only dependency graph statically imported into every UI. Output adapters are lazy-loaded behind enforced size budgets, and unreferenced fonts and copied icons were dropped from `dist`. |
| 044 | `3515b13` | A Gather Source was represented independently in URL regexes, host permissions, content-script matches, context-menu patterns, a dispatch chain, credential defaults, and download policy — six-plus synchronized edits per change, and they had already drifted. One catalog is now authoritative and derives the rest. |
| 045 | `1a76202` | A 48.2 KB collector bundle loaded at `document_start` on every matched page and imported all eight source collectors, existing mainly to install two keyboard shortcuts. A small key adapter stays always-on; each source collector is now injected only when its Gather Run reaches collection. |
| 046 | `eab6ed8` | Eight Pane View modules exported `__reset*ForTests` functions purely so tests could reach module-level mutable state, and the login throttle counters they exposed were per-process — lost on restart and not shared across replicas. Module state is now injected instead of exported, and the throttle moved to a shared `login_throttle_attempts` table. |
| 049 | PR #83 (`agent/049-maintenance-scheduler`) | Three schedulers repeated the same guarded prologue (a fourth checked only the sync guard, a fifth none), the 581-line worker trusted its jsonb progress through unchecked casts and rewrote any `s3_derivatives` phase to `s3_originals` regardless of job type, and `errorCount`/`lastError` were rendered but never set. One `scheduleMaintenanceJob` owns the prologue with the three jobs as thin descriptors, `parseMaintenanceProgress` validates the phase against the job's own type and fails closed, the eligibility SQL exists once, `deleteFolders` is guarded like the schedulers, and the worker has pglite-backed tests. Manual Step 6 smoke was not run (no local archive). |
| 052 | PR #82 (`agent/052-gallery-browse-session`) | Three navigation loops (viewer, detail panel, grid) wrapped over the *loaded* array with modulo arithmetic and knew nothing about further pages, the viewer captured its item list at open time, and comic mode fetched by offset and re-sorted merged pages on the client. `useGalleryBrowse` is now one browse session behind a `GalleryPageSource` port: server order is appended as-is, a refetched page 1 dedupes by key, one in-flight request is shared by button, observer, keyboard, detail panel, and viewer, `stepMedia`/`stepEntry` load before they loop and stay put backward while more pages exist, the viewer is controlled by media id, and comic cards render from summaries with the reader loading a complete comic on demand. Manual Step 5 smoke was not run (no local archive). |
| 048 | PR #80 (`agent/048-gallery-browse-state`) | Gallery browse state was reconciled across six files with four candidate sources per flag, `comic ⇒ recursive` written six times, and three snapshot request builders — one of which made the sidebar fetch 500 media rows it never rendered. `useGalleryBrowseState` now owns browse state: the flags resolve from the URL only (a URL without a flag means off; the remembered in-folder flags seed the first-visit redirect and folder entry from the root, which is what the settings drawer's "default recursive browsing" toggle sets), every rule is stated once in `foldBrowseFlags` and pure, node-tested intents, the 32-hex random seed is persisted, root preferences stay behind the storage adapter, and page, sidebar, and loader share one snapshot request. Deliberate deltas, all reviewed: submitting an empty search now clears the query (previously kept the old one), toggling comic/recursive keeps the selected `media` in the URL (the old code kept it only in local state), and the single `useAppSettings` instance lives in the layout so the drawer and theme sync agree. Manual Step 6 smoke was not run (no local archive). |
| 051 | PR #79 (`agent/051-gallery-server-order`) | Regular media used a keyset cursor over `md5(seed:id)` in byte order while comic mode fetched by offset and re-sorted on the client, so random comic pages moved under the user's scroll and `10.jpg` listed before `2.jpg`. The server now owns one seeded order over media and comic summaries (`md5(seed:kind:id)`, natural ICU collation via migration 0018, discriminated cursors rejected on any seed/mode/kind mismatch), serves cursor-paginated comic summaries plus `getGalleryComic`, and proves concatenated pages equal the fixed-seed order under pglite. Manual Step 6 smoke was not run (no local archive); the client change is limited to the hex seed. |
| 047 | `eab6ed8` | With the repository public, two test files still carried literal fixture content that the documentation pass had removed everywhere else, readable by anyone scanning how the code is tested. The fixtures were neutralized without losing coverage. |

## Historical and rejected work

- **037: Batch sync registration and ancestor upserts** — REJECTED 2026-08-17. The code claim
  holds (`sync/store.ts` opens one transaction per uploaded object and re-upserts every ancestor,
  ~5 + 2·depth statements per file), but pushes run three-wide behind an S3 PUT per item, so DB
  registration is not the critical path and nobody has measured otherwise. Large effort, HIGH risk,
  changes transactional boundaries. Revive only if a push profile shows registration as a material
  share of wall time; if it does, first try a per-run memo of already-upserted ancestor paths
  before building a batch endpoint. Full text: `git log --diff-filter=D --follow -- docs/plans/037-batch-sync-registration.md`.
- **050: Library repository seam** — MERGED into Plan 051 as its Step 0 on 2026-08-17. Half of it
  (cursor tightening, random-mode SQL pins) would have been rewritten by 051 within days; the
  surviving half (condition/mapper dedupe, order/cursor agreement test, repository-level rendered
  SQL) is now 051's first commit. Full text: `git log --diff-filter=D --follow -- docs/plans/050-library-repository-seam.md`.
- **023: Gallery performance audit** — REJECTED / superseded. Its stored-derivative and prewarming
  recommendations predate the controlling Shutter-only architecture; re-measure gallery queries
  before reviving any still-relevant index idea.
- Deleting source objects during ordinary soft deletion — rejected because immutable source retention
  is an explicit recovery property; hard wipe is the destructive boundary.
- Hashing every file during prune — rejected because prune deliberately relies on the indexed
  path/size/mtime fingerprint and avoids source reads.
- Following symlinks or indexing non-regular files — rejected because selected-root containment and
  predictable local-file semantics are intentional safety constraints.
- Pane-owned rendition prewarm/worker queues — rejected because Shutter is the sole rendition provider.

## Status vocabulary

- **TODO**: ready for an executor after dependencies and drift check.
- **IN PROGRESS**: branch exists, is pushed to `origin`, and implementation has begun.
- **BLOCKED**: a named STOP condition or dependency prevents safe progress.
- **DONE**: all plan gates and done criteria are satisfied; record the commit and delete the file.
- **REJECTED**: evidence or architecture superseded the proposal; retain the record for context.

## Index maintenance

Executors have repeatedly landed plans without updating this file — 026, 030, and 036 all shipped
while still listed as BLOCKED or TODO, which made 037 look blocked for weeks when it was ready. When
a plan lands, update its row in the same commit. Record work branches on `origin`, not only locally.
