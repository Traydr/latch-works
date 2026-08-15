# Improvement plan index

Plans 024–040 were generated from the deep repository survey at commit `fd5693d` on 2026-07-13;
plans 041–045 from the Gather Box architecture review on 2026-07-15; plans 046–047 from the
open-sourcing test audit on 2026-07-27; plans 048–050 from the Pane View architecture review at
commit `7076ce8` on 2026-08-14. Every open plan is written for an implementation agent and
begins with a drift check. Status changes belong in this index and the corresponding plan.

Last audited 2026-07-28 at commit `8977ebe`. Completed plan files are removed once their outcome is
recorded below; recover full text with `git log --diff-filter=D --follow -- docs/plans/<file>`.

## Open work

| Plan | Outcome | Priority | Effort | Depends on | Status |
|---|---|---:|---:|---|---|
| [025](025-repair-drizzle-snapshot-baseline.md) | Restore a current Drizzle snapshot baseline | P1 | M | — | BLOCKED |
| [037](037-batch-sync-registration.md) | Batch server registration and ancestor writes | P3 | L | 026, 030, 036 (all done) | TODO |
| [040](040-frame-view-pdf-spike.md) | Validate and specify Frame PDF reading | P2 | M spike | 033, 034 (both done) | BLOCKED |
| [048](048-gallery-browse-state-module.md) | One browse-state module for the gallery; sidebar stops fetching 500 media rows | P2 | L | — | TODO |
| [049](049-maintenance-job-scheduler.md) | One maintenance scheduler and a validated progress seam for the cleanup worker | P2 | M | — | TODO |
| [050](050-library-repository-seam.md) | Test the library repository at its seam; collapse duplicated query internals | P3 | M | — | TODO |

Plans 037, 048, 049, and 050 are ready to execute; 048–050 are independent of each other and of 037.
Plans 025 and 040 are blocked on environment access rather than on code (see below); neither blocks
the others. Plan 049 deliberately adds no migration because 025 is blocked; see its Decisions section.

## Execution blockers

### 025 — blocked on disposable PostgreSQL, and the drift has grown

Still genuinely blocked, and worse than when the plan was written. The migration journal now records
through `0012` while the newest snapshot is still `0006`, which continues to model the removed
`thumbnails` table. Two migrations were hand-written past the stale baseline after this plan was
filed: `0011_serialize_sync_hard_wipe` (Plan 030) and `0012_shared_login_throttle` (Plan 046). A
`drizzle-kit generate` today would diff `0006` against the current schema and emit both the obsolete
thumbnail teardown *and* re-creation of the `login_throttle_attempts` table and the active-hard-wipe
partial unique index that are already applied.

The original blocker — `drizzle-kit generate --custom` copies the latest snapshot instead of deriving
one — was diagnosed correctly and the plan already specifies the fix (ordinary generation, then
replace only the SQL body with comments). What is missing is execution: Steps 1 and 4 require two
disposable PostgreSQL databases, which no agent run so far has had.

**To resolve**: provide two throwaway PostgreSQL URLs (a fresh one and one migrated through `0012`),
then run the plan as written with the drift corrections now recorded in its Current state section.
The plan's target file is renumbered from `0011_*` to `0013_*`, and the expected snapshot must now
*include* `login_throttle_attempts` and `maintenance_jobs_active_hard_wipe_unique` rather than treat
them as unexplained. No local Docker/Postgres is required if a hosted scratch database is easier.

### 040 — blocked on user-only desktop gates; urgency already relieved

Still blocked, but the reason it was P2-urgent no longer applies. The spike stopped because
`pnpm --filter @latch-works/frame-view package` and `make` produce a desktop distributable that an
agent cannot launch or smoke-test, so Steps 2 and 3 (packaged worker resolution, first-page latency,
bounded-canvas measurement) cannot be completed headlessly.

The original risk was that the Showcase advertised a Frame PDF reader that does not exist. Plan 039
fixed that: `frame-view/index.mdx`, `comics-and-stories.mdx`, and `troubleshooting.mdx` now all say
PDF reading is planned and not shipped. Frame still has no `pdfjs-dist` dependency and no PDF in
`shared/contracts.ts`, so the code and the docs agree.

**To resolve**: this needs a human at a desktop, or it should be deferred. Either run Steps 2–3
interactively on a supported OS and record the measurements, or downgrade the plan to P3/deferred
until Frame PDF reading is actually wanted. Nothing else depends on it.

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
| 047 | `eab6ed8` | With the repository public, two test files still carried literal fixture content that the documentation pass had removed everywhere else, readable by anyone scanning how the code is tested. The fixtures were neutralized without losing coverage. |

## Historical and rejected work

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
