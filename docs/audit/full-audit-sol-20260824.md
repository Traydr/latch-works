# Codebase simplification audit

Audit complete.

- Coverage: all 880 tracked files, grouped into 38 non-overlapping subsystems.
- Result: 34 subsystems with recommendations, 4 explicit skips.
- Accepted recommendations: 59.
- Rejected after validation/materiality review: 8.
- Repository state: unchanged at `be776cbd8b13ed174357dc1fc56b96d13471b4d2`.
- No files were edited. No tests, builds, migrations, generators, commits, or pushes were run.

The audit used module depth and locality as the decision standard. Recommendations were retained only when they remove invalid state, duplicate authority, repeated protocol facts, stale async ownership, or meaningful unnecessary work.

## 1. Coverage contract

Tests listed below are the focused suites for each row. App-level integration tests were also inspected where they cross a subsystem seam.

| ID | Exact ownership boundary, interfaces, call sites, tests | Final status |
|---|---|---|
| S01 | `packages/media-domain/**`; `MediaItem`, `FolderNode`, media detection, browser-entry model; used by all scanners and viewers; colocated tests | recommend, 2 |
| S02 | `packages/media-index/**`; scan events, `SyncPlan`, plan items; used by Lockstep; scan/plan tests | recommend, 2 |
| S03 | `packages/media-storage/**`; S3 client, signing, listing/deletion; Pane sync/media callers; `s3.test.ts` | recommend, 2 |
| S04 | `lockstep-core` planning, hash cache, snapshots, progress coalescer, exported types; CLI/desktop callers; focused tests | recommend, 2 |
| S05 | Remaining `lockstep-core` push, prune, remote adapter, doctor and format modules; CLI/desktop callers; push/prune tests | recommend, 2 |
| S06 | `packages/shutter-protocol/**`, `packages/shutter-client/**`; vendored Shutter contracts and client | skip |
| P01 | Pane router, start/root document, non-API routes, generated route tree, route-build policy | recommend, 1 |
| P02 | Pane `components/**`, dither charts, UI controls, `lib/utils.ts`, query-client setup | recommend, 2 |
| P03 | Pane `features/gallery/**`; browse state, grid, thumbnail resolution, viewer handoff; gallery tests | recommend, 2 |
| P04 | Pane comics, viewer, PDF rendering and viewer-state hook; viewer/gallery call sites and tests | recommend, 2 |
| P05 | Pane client auth/settings plus hydration/mobile hooks; gallery layout/settings callers | recommend, 1 |
| P06 | Pane client management, library, media delivery and stats features; gallery/manage/stats callers and tests | recommend, 2 |
| P07 | Pane server auth, HTTP parsing, environment and security headers, auth routes; auth/security tests | recommend, 2 |
| P08 | Pane DB schema, Drizzle migrations, coordination lock and viewer-state repository; PGlite and migration consumers | recommend, 2 |
| P09 | Pane `server/library/**`; snapshot/listing/comic queries, cursors, fixtures, repository tests | skip |
| P10 | Pane sync store, validation and sync routes; Lockstep callers; route/store/validation tests | recommend, 1 |
| P11 | Pane server media delivery, Shutter adapter and media routes; gallery/sync/maintenance callers and media tests | recommend, 2 |
| P12 | Pane management, maintenance worker, folder deletion and stats backend; management/stats tests | recommend, 2 |
| F01 | Frame shared contracts, preload and main IPC; renderer callers and IPC/preload tests | recommend, 1 |
| F02 | Frame catalog runtime, worker and SQLite media index; IPC/settings callers and catalog tests | recommend, 2 |
| F03 | Frame thumbnails plus `mediaProtocol`, `mediaToolsService`, `mediaBinaryResolver`; worker/broker/service tests | recommend, 2 |
| F04 | Frame main lifecycle, windows, folders, settings and persistence; lifecycle/settings tests | recommend, 2 |
| F05 | Frame renderer store, bridge adapters and bootstrap hooks; renderer/store tests | recommend, 2 |
| F06 | Frame gallery browser and navigation UI; layout, selection and virtualization call sites | skip |
| F07 | Frame viewer, settings UI, metadata queue, showcase and packaging; renderer tests and packaging configuration | recommend, 1 |
| G01 | Gather source catalog, site detection, collector entries and all source collectors; collector/catalog tests | recommend, 2 |
| G02 | Gather run/reducer/controller/queue and message contracts; queue/controller/coordinator tests | recommend, 2 |
| G03 | Gather background coordinator and offscreen lifecycle; coordinator/offscreen/slot tests | recommend, 1 |
| G04 | Gather downloader, filesystem, directory handles, codecs and materialization; downloader/codec/executor tests | recommend, 2 |
| G05 | Gather visible UI, options, manifest, rules, build and static policy | recommend, 1 |
| L01 | Lockstep desktop main, shared contracts, preload and IPC; profile/run-service tests | recommend, 2 |
| L02 | Lockstep desktop renderer, showcase and packaging; main-service tests as lifecycle call-site evidence | recommend, 2 |
| L03 | `apps/lockstep-cli/**`; CLI parsing, config, interaction, execution, output and packaging; CLI tests | recommend, 2 |
| W01 | Showcase Astro site, product data, docs content and navigation; Astro build interface | recommend, 2 |
| W02 | Real screenshot capture, fixture preparation and desktop preview harnesses; screenshot consumers | recommend, 2 |
| I01 | `.railway/**`, Compose/deployment topology, environment templates and Railway configuration skill | recommend, 1 |
| I02 | Root workspace scripts, CI, Biome, Knip, TypeScript, Vitest and Oxlint tooling | recommend, 1 |
| I03 | Docs, ADRs, plans, governance, static brand assets and inactive package placeholders | skip |

The independent coverage pass reconciled exactly:

- 747 tracked app files
- 79 tracked package files
- 54 root, infrastructure, tooling, documentation and asset files

## 2. Highest-priority implementation slices

| Rank | Finding | Impact | Confidence | Effort | Why first |
|---:|---|---|---|---|---|
| 1 | P07-A explicit proxy-trust parsing | high | high | small | Documented `"false"` currently enables trust |
| 2 | P04-A stable PDF render attempt | high | high | small | Fixes cancellation gap that can start an unowned render |
| 3 | G02-A persisted Gather phases | high | high | small | Live cancellation writes a state the loader drops |
| 4 | S03-A signer-owned object key | high | high | small | Removes split object identity at an external boundary |
| 5 | G04-B exact failed-source identity | high | high | small | Filename matching can retry successful items |
| 6 | G04-A MIME-owned output naming | high | high | small | Filename guesses can skip the wrong transformed output |
| 7 | F04-A atomic window snapshot | high | high | small | Prevents torn observations and three close-time writes |
| 8 | P07-B collision-free throttle keys | high | high | small | Current opaque keys can alias different users/clients |
| 9 | L01-A commit profiles after persistence | high | high | medium | Failed writes currently remain visible in memory |
| 10 | P08-B exclusive viewer progress | medium | medium | small-medium | Clarifies the payload before write serialization |
| 11 | P04-B serialized viewer-state writes | high | high | medium | Prevents older network completions from winning |
| 12 | F03-B thumbnail task lifecycle | high | high | medium | Centralizes competing broker terminal transitions |
| 13 | F02-A atomic catalog scan | high | high | large | Failed scans currently expose mixed partial snapshots |
| 14 | G03-A explicit executor observation | high | medium-high | medium | Prevents observation failures from being treated as idle |
| 15 | P12-B disjoint folder-root deletion | medium | high | small | Removes order-dependent destructive updates |

Best first slices:

1. P07-A, then P07-B.
2. P04-A independently.
3. G02-A independently.
4. P08-B, then P04-B.
5. F04-A, then F04-B.
6. L01-A with L01-B.
7. W02-A, then W02-B.
8. L03-B and S05-B before L02-A and L03-A.
9. Coordinate P08-A, P10-B and P12-A in one migration release, but treat them as parallel changes rather than causal prerequisites.
10. Implement F02-A before considering F02-B.

## 3. Confirmed recommendations

Each entry records evidence, the current problem, the smallest credible change, risk, and validation.

### Shared packages and infrastructure

- **S01-A, one media-format registry.** Evidence: [media.ts](/Users/traydr/dev/latch-works/packages/media-domain/src/media.ts:4), [Pane validation](/Users/traydr/dev/latch-works/apps/pane-view/src/server/sync/validation.ts:111), [Lockstep MIME mapping](/Users/traydr/dev/latch-works/packages/lockstep-core/src/remote-api.ts:361). Extension, media type and MIME facts can disagree. Put recognized/canonical extensions, `MediaType` and MIME in one media-domain registry; preserve Frame’s custom-extension fallback and media-storage’s dependency direction. Extend existing media, scan and sync tests with cross-consumer table cases. Confidence: high.

- **S01-B, remove the shallow shared browser-entry model.** Evidence: [browser-entries.ts](/Users/traydr/dev/latch-works/packages/media-domain/src/browser-entries.ts:4), [Pane repository](/Users/traydr/dev/latch-works/apps/pane-view/src/server/library/repository.ts:380), [gallery listing](/Users/traydr/dev/latch-works/apps/pane-view/src/server/library/gallery-listing.ts:34). Pane is its only real consumer, while Frame owns a richer local model. Give Pane mode-discriminated media/comic listing responses and preserve server ordering; remove the shared export. Update listing and gallery tests. Confidence: high.

- **S02-A, discriminated sync-plan items.** Evidence: [sync-plan.ts](/Users/traydr/dev/latch-works/packages/media-index/src/sync-plan.ts:9), [core types](/Users/traydr/dev/latch-works/packages/lockstep-core/src/types.ts:8). Optional local/remote fields permit action-incompatible shapes. Use upload/local, update-or-keep/local+remote and delete/remote variants, reused by core. Preserve the smaller renderer DTO. Extend plan and push failure-path tests. Confidence: high.

- **S02-B, derive completed skipped count.** Evidence: [scan.ts](/Users/traydr/dev/latch-works/packages/media-index/src/scan.ts:61), [plan-sync.ts](/Users/traydr/dev/latch-works/packages/lockstep-core/src/plan-sync.ts:118), [inconsistent fixture](/Users/traydr/dev/latch-works/apps/lockstep/src/showcase/fixtures.ts:33). Completed results duplicate `skipped` and `skippedEntries.length`. Remove the scalar from terminal models, retaining it only for progress events. Update scan, plan, CLI and fixture tests. Confidence: high.

- **S03-A, signer-owned original object key.** Evidence: [s3.ts](/Users/traydr/dev/latch-works/packages/media-storage/src/s3.ts:357), [upload route](/Users/traydr/dev/latch-works/apps/pane-view/src/routes/api.sync.upload-url.ts:58). Route and signer independently derive the key. Make signing validate SHA/extension, derive the key, and return it with the URL. Preserve wire compatibility during rollout and add malformed-hash/key-equivalence tests. Confidence: high.

- **S03-B, expose only live storage operations.** Evidence: [storage interface](/Users/traydr/dev/latch-works/packages/media-storage/src/s3.ts:32), [unused read/config operations](/Users/traydr/dev/latch-works/packages/media-storage/src/s3.ts:202), [package exports](/Users/traydr/dev/latch-works/packages/media-storage/src/index.ts:1). Tests keep retired operations looking public. Remove unused reads, configuration inspection and direct put operations; retain live signing, key-only listing and batch deletion. Verify with repository-wide reference search and storage tests. Confidence: high.

- **S04-A, explicit planning source.** Evidence: [PlanSyncOptions](/Users/traydr/dev/latch-works/packages/lockstep-core/src/types.ts:70), [precedence](/Users/traydr/dev/latch-works/packages/lockstep-core/src/plan-sync.ts:23). Optional URL, token and snapshot fields permit incomplete or competing sources. Use `none | snapshot | authenticated-api`. Update CLI/desktop construction and planning tests. Confidence: high.

- **S04-B, coalesce scan progress by stage.** Evidence: [coalescer](/Users/traydr/dev/latch-works/packages/lockstep-core/src/scan-progress-coalescer.ts:17), [scan emissions](/Users/traydr/dev/latch-works/packages/media-index/src/scan.ts:412). Keying on path flushes nearly every event, defeating the time window. Key on lifecycle stage while retaining the latest path as payload. Existing coalescer tests should add rapidly changing paths. Confidence: high.

- **S05-A, endpoint-specific remote operations.** Evidence: [generic adapter](/Users/traydr/dev/latch-works/packages/lockstep-core/src/remote-api.ts:58), [push caller](/Users/traydr/dev/latch-works/packages/lockstep-core/src/push-changes.ts:116), [prune caller](/Users/traydr/dev/latch-works/packages/lockstep-core/src/prune-deleted.ts:73). Callers supply route, unrelated body unions and response schema together. Replace with named start/finalize/upload/complete/delete/snapshot methods while keeping production and test adapters. Preserve endpoint error behavior in push/prune tests. Confidence: high.

- **S05-B, one terminal push/prune outcome.** Evidence: [push terminal branches](/Users/traydr/dev/latch-works/packages/lockstep-core/src/push-changes.ts:184), [prune terminal branches](/Users/traydr/dev/latch-works/packages/lockstep-core/src/prune-deleted.ts:139). Remote finalization, emitted events and return/throw state are derived separately; abort timing can make them disagree. Construct one completed/cancelled/failed outcome and project all terminal behavior from it. Add abort-at-finalization and partial-failure tests. Confidence: high.

- **I01-A, Railway resource handles.** Evidence: [.railway/railway.ts](/Users/traydr/dev/latch-works/.railway/railway.ts:22). Raw interpolation strings and internal deploy patches duplicate resource identity and are rename-sensitive. Use resource handles and `.env` fields exposed by the Railway configuration interface. Keep Compose as the local adapter. Validate with Railway config inspection when implemented. Confidence: high.

- **I02-A, one authoritative read-only root check.** Evidence: [package.json](/Users/traydr/dev/latch-works/package.json:8), [workflow](/Users/traydr/dev/latch-works/.github/workflows/ci.yml:24). Root scripts and CI duplicate stages, CI formats before checking, and neither authoritative check includes tests. Add one non-writing root check command and have CI invoke it; retain the current full Electron build initially. Validate individual failure propagation and CI parity. Confidence: high.

### Pane View

- **P01-A, one authenticated pathless route.** Evidence: [_gallery route](/Users/traydr/dev/latch-works/apps/pane-view/src/routes/_gallery.tsx:5), [manage route](/Users/traydr/dev/latch-works/apps/pane-view/src/routes/manage.tsx:5), [generated tree](/Users/traydr/dev/latch-works/apps/pane-view/src/routeTree.gen.ts:376). Three protected pages repeat the same guard and client-only setting. Move them under one pathless authenticated parent, keeping public URLs. Regenerate, never hand-edit, `routeTree.gen.ts`; test session expiry and loader revalidation. Confidence: medium.

- **P02-A, chart config owns used paint metadata.** Evidence: [chart registry](/Users/traydr/dev/latch-works/apps/pane-view/src/components/dither-kit/chart-context.tsx:232), [Area effect](/Users/traydr/dev/latch-works/apps/pane-view/src/components/dither-kit/area.tsx:36), [Stats config/caller](/Users/traydr/dev/latch-works/apps/pane-view/src/features/stats/StatsPage.tsx:32). Static paint facts are copied into effect-populated lifecycle registries. Put used Area/Bar/Pie kind and variant fields in existing config, without redesigning the compositional chart interface. Preserve overlay/marker behavior and decide local-fork ownership. Add initial-render and Strict Mode chart tests. Confidence: high.

- **P02-B, remove unused dither feature groups.** Evidence: [registry manifest](/Users/traydr/dev/latch-works/apps/pane-view/dither-kit.json:29), [barrel](/Users/traydr/dev/latch-works/apps/pane-view/src/components/dither-kit/index.ts:4). Avatar, button, gradient and radar installations have no callers and contribute seven files, about 981 lines. Remove them through the registry-supported flow, retaining active area/bar/pie/core groups. Repeat reference search and smoke-test Stats after implementation. Confidence: high.

- **P03-A, delete five unused gallery modules.** Evidence: [BrowserHeader.tsx](/Users/traydr/dev/latch-works/apps/pane-view/src/features/gallery/BrowserHeader.tsx:21), [active header](/Users/traydr/dev/latch-works/apps/pane-view/src/features/gallery/GalleryPage.tsx:443), [PaneViewImage](/Users/traydr/dev/latch-works/apps/pane-view/src/features/gallery/PaneViewImage.tsx:53). Delete `BrowserHeader.tsx`, `GalleryPending.tsx`, `media-preview-url.ts`, `pane-view-media-url.ts` and `thumbnail-size.ts`. They have no callers and compete with current owners. Repeat static reference search and gallery build/tests. Confidence: high.

- **P03-B, one thumbnail cache lifecycle.** Evidence: [resolver state](/Users/traydr/dev/latch-works/apps/pane-view/src/features/gallery/batched-thumbnail-resolver.ts:32), [result transitions](/Users/traydr/dev/latch-works/apps/pane-view/src/features/gallery/batched-thumbnail-resolver.ts:127), [retry state](/Users/traydr/dev/latch-works/apps/pane-view/src/features/gallery/batched-thumbnail-resolver.ts:254). Status, in-flight, batch, URL, retry time and attempts can disagree. Use resolving, pending, ready and failed variants, retaining the public resolver interface. Extend resolver tests for failure, retry and stale completion. Confidence: high.

- **P04-A, stable PDF render attempts.** Evidence: [active render model](/Users/traydr/dev/latch-works/apps/pane-view/src/features/viewer/PdfDocument.tsx:24), [stale guard](/Users/traydr/dev/latch-works/apps/pane-view/src/features/viewer/PdfDocument.tsx:203), [task start](/Users/traydr/dev/latch-works/apps/pane-view/src/features/viewer/PdfDocument.tsx:228). Cancellation during `getPage()` erases the identity token; the stale check can then pass and start an unowned render. Keep `{cancelled, renderTask?}` for the attempt lifetime. Add deferred-`getPage()` eviction and unmount tests. Confidence: high.

- **P04-B, serialize subject-bound viewer writes.** Evidence: [pending refs](/Users/traydr/dev/latch-works/apps/pane-view/src/features/viewer/use-library-viewer-state.ts:36), [clear-before-await](/Users/traydr/dev/latch-works/apps/pane-view/src/features/viewer/use-library-viewer-state.ts:58), [duplicate cleanup](/Users/traydr/dev/latch-works/apps/pane-view/src/features/gallery/MediaViewerSession.tsx:142). Multiple writes can complete out of order and persist older progress. Use one pending subject-bound value, one in-flight promise and one drain loop; remove redundant session cleanup after the hook guarantee is proven. Add deferred/rejected-store tests. Confidence: high.

- **P05-A, one local-preference owner.** Evidence: [settings hook](/Users/traydr/dev/latch-works/apps/pane-view/src/features/settings/useAppSettings.ts:10), [hard-coded reset](/Users/traydr/dev/latch-works/apps/pane-view/src/features/settings/SettingsDrawer.tsx:183), [unreset volume](/Users/traydr/dev/latch-works/apps/pane-view/src/features/gallery/MediaViewerSession.tsx:52). The reset knows foreign keys but misses viewer volume; defaults are briefly published before persisted filters load. Add a small settings persistence/reset module and synchronously initialize on the current client-only route. Keep browse serialization local. Test malformed storage, first request and exact reset scope. Confidence: high.

- **P06-A, split obsolete snapshot responsibilities.** Evidence: [request modes](/Users/traydr/dev/latch-works/apps/pane-view/src/features/library/library-service.ts:23), [unused media result](/Users/traydr/dev/latch-works/apps/pane-view/src/features/library/library-service.ts:60), [management caller](/Users/traydr/dev/latch-works/apps/pane-view/src/features/management/ManagementPage.tsx:66), [repository query](/Users/traydr/dev/latch-works/apps/pane-view/src/server/library/repository.ts:291). Cursor listings own gallery media, while management fetches up to 500 unused media rows. Split navigation folders from all-folder management reads and remove offset media paging. In the same repository slice, stop projecting production-unmaintained folder counts; preserve only needed `hasChildren`. Update service, repository, gallery and management tests. Confidence: high.

- **P06-B, exact media-delivery transport contract.** Evidence: [client result](/Users/traydr/dev/latch-works/apps/pane-view/src/features/media/media-delivery-service.ts:14), [server result](/Users/traydr/dev/latch-works/apps/pane-view/src/server/media/resolve-delivery-url.ts:110), [defensive consumer](/Users/traydr/dev/latch-works/apps/pane-view/src/features/gallery/batched-thumbnail-resolver.ts:66). The same result has two owners; client `ready.url` is optional and deduplication runs twice. After P11-A, define one exact request/result schema, require ready URL, preserve exact variants, and keep dedupe in the resolver. Add duplicate and mixed-result tests. Confidence: high.

- **P07-A, parse proxy trust literally.** Evidence: [environment schema](/Users/traydr/dev/latch-works/apps/pane-view/src/env/server.ts:18), [.env.example](/Users/traydr/dev/latch-works/.env.example:26), [client-IP trust](/Users/traydr/dev/latch-works/apps/pane-view/src/server/auth/client-ip.ts:1). `z.coerce.boolean()` turns the documented string `"false"` into true. Accept only `"true"`/`"false"`, default unset to false, reject other values. Add environment and login-route integration cases. Confidence: high.

- **P07-B, injective throttle keys.** Evidence: [key construction](/Users/traydr/dev/latch-works/apps/pane-view/src/server/auth/login-throttle-core.ts:22), [text primary key](/Users/traydr/dev/latch-works/apps/pane-view/src/server/db/schema.ts:134). Colon concatenation can alias IPv6/user pairs and the `user:` namespace. Use only a collision-free tagged string or tuple serializer, versioned to avoid old-key overlap; do not add columns or a generalized framework. Existing rows expire in five minutes. Add collision cases. Confidence: high.

- **P08-A, viewer state belongs to library entries.** Evidence: [schema](/Users/traydr/dev/latch-works/apps/pane-view/src/server/db/schema.ts:359), [only live validator](/Users/traydr/dev/latch-works/apps/pane-view/src/features/viewer/viewer-state-service.ts:5), [manual cleanup](/Users/traydr/dev/latch-works/apps/pane-view/src/server/management/cleanup-worker.ts:275). Unused polymorphism permits dangling rows and leaks deletion knowledge. Replace subject type/id with `libraryEntryId` and a cascading FK; keep the subject enum for favorites. Audit dangling or historical collection rows before migration. Add repository, cascade and migration tests. Confidence: high.

- **P08-B, exclusive viewer progress.** Evidence: [server types](/Users/traydr/dev/latch-works/apps/pane-view/src/server/viewer-state/types.ts:1), [validator](/Users/traydr/dev/latch-works/apps/pane-view/src/features/viewer/viewer-state-service.ts:10), [hook patch](/Users/traydr/dev/latch-works/apps/pane-view/src/features/viewer/use-library-viewer-state.ts:5). Empty and page-plus-position states are accepted. Use a page-or-position union at wire and repository boundaries, replacing pending progress rather than merging fields. Do not add a persisted discriminator; add a DB check only if the migration audit justifies it. Add validator/repository/hook replacement tests. Confidence: medium.

- **P10-B, remove `sync_run_items`.** Evidence: [schema](/Users/traydr/dev/latch-works/apps/pane-view/src/server/db/schema.ts:337), [upload write](/Users/traydr/dev/latch-works/apps/pane-view/src/server/sync/store.ts:223), [delete write](/Users/traydr/dev/latch-works/apps/pane-view/src/server/sync/store.ts:296). The table has no production reader and records incomplete/inaccurate actions. Confirm there is no external SQL/reporting consumer, export if retention matters, then drop writes, table, enum and wipe cleanup. Retain run-level history tests and add migration coverage. Confidence: medium.

- **P11-A, one media-delivery context and batch query.** Evidence: [duplicate repository models](/Users/traydr/dev/latch-works/apps/pane-view/src/server/media/repository.ts:7), [three dependency reads](/Users/traydr/dev/latch-works/apps/pane-view/src/server/media/resolve-delivery-url.ts:18), [original N-query path](/Users/traydr/dev/latch-works/apps/pane-view/src/server/media/resolve-delivery-url.ts:136). An all-original batch can issue 48 DB reads. Use one context and one batch read for every variant, preserving stored object keys, result order and per-item failure. Add PGlite mixed-batch and 48-original tests. Confidence: high.

- **P11-B, one process-owned S3 client.** Evidence: [factory](/Users/traydr/dev/latch-works/apps/pane-view/src/server/media/storage-client.ts:4), [AWS allocation](/Users/traydr/dev/latch-works/packages/media-storage/src/s3.ts:52), [per-item caller](/Users/traydr/dev/latch-works/apps/pane-view/src/server/media/resolve-delivery-url.ts:30). Media, Shutter, original-route and sync signing repeatedly allocate clients; maintenance already demonstrates lazy reuse. After S03-B, expose one lazy Pane getter while keeping operations injectable. Test constructor count and shared identity. Confidence: high.

- **P12-A, phase-specific hard-wipe progress.** Evidence: [progress model](/Users/traydr/dev/latch-works/apps/pane-view/src/server/management/maintenance-progress.ts:42), [worker phases](/Users/traydr/dev/latch-works/apps/pane-view/src/server/management/cleanup-worker.ts:441). Prefix/token fields exist outside the orphan phase and drive a dead one-prefix successor algorithm. Use a phase union where only orphan cleanup owns its continuation token; parse legacy rows during migration. Add resume tests for every phase. Confidence: high.

- **P12-B, normalize folder deletions.** Evidence: [selection](/Users/traydr/dev/latch-works/apps/pane-view/src/features/management/FolderPicker.tsx:30), [serial updates](/Users/traydr/dev/latch-works/apps/pane-view/src/server/management/folder-delete.ts:85). Parent and child selections cause overlapping, order-dependent work and `2N` SQL updates. Normalize delimiter-aware disjoint roots, then execute one entry update and one folder update with aggregate results. Test prefix collisions, nested roots and soft-deleted rows. Confidence: high.

### Frame View

- **F01-A, make the IPC registry the real transport seam.** Evidence: [unused args schema](/Users/traydr/dev/latch-works/apps/frame-view/src/shared/ipcContracts.ts:18), [manual public interface](/Users/traydr/dev/latch-works/apps/frame-view/src/shared/types.ts:78), [manual preload map](/Users/traydr/dev/latch-works/apps/frame-view/src/preload/frameViewApi.ts:36). Each invoke is repeated across registry, interface, preload and main. Remove duplicate `requestSchema`; use typed main/preload helpers for tuple parsing and results, plus event contracts, while leaving named business handlers explicit. Add table-driven registration and malformed-tuple tests. Confidence: high.

- **F02-A, atomic media-index scan session.** Evidence: [live batch writes](/Users/traydr/dev/latch-works/apps/frame-view/src/main/db/mediaIndexService.ts:133), [cancel behavior](/Users/traydr/dev/latch-works/apps/frame-view/src/main/db/mediaIndexService.ts:220), [runtime cancellation gap](/Users/traydr/dev/latch-works/apps/frame-view/src/main/catalog/CatalogRuntime.ts:388). Cancellation/failure leaves mixed old and partial-new rows, contradicting the documented committed-snapshot invariant. Stage by scan ID; commit atomically publishes, abort discards. Define crash recovery and overlapping-root ordering. Add real SQLite cancellation/failure/commit/recovery tests. Confidence: high.

- **F02-B, remove the async ORM proxy if the direct repository is smaller.** Evidence: [two DB handles](/Users/traydr/dev/latch-works/apps/frame-view/src/main/db/mediaIndexService.ts:22), [proxy](/Users/traydr/dev/latch-works/apps/frame-view/src/main/db/mediaIndexService.ts:72), [duplicate schema](/Users/traydr/dev/latch-works/apps/frame-view/src/main/db/schema.ts:3). After F02-A, compare seven native prepared operations against the current `DatabaseSync` plus Drizzle proxy. Remove proxy and duplicated DDL only if demonstrably smaller; preserve `CatalogMediaIndex` injection. Add initialization, upgrade, rollback and stats tests. Confidence: medium.

- **F03-A, ThumbnailService owns disk cache writes.** Evidence: [service ownership](/Users/traydr/dev/latch-works/apps/frame-view/src/main/services/thumbnailService.ts:93), [worker write](/Users/traydr/dev/latch-works/apps/frame-view/src/main/thumbnail/ThumbnailWorkerRuntime.ts:316), [broker cancellation](/Users/traydr/dev/latch-works/apps/frame-view/src/main/thumbnail/ThumbnailBrokerService.ts:744). A late worker can recreate a cleared cache. Return generated bytes from workers and let the service alone write, prune, clear and count. Test clear/cancel races and late completion. Confidence: high.

- **F03-B, explicit broker task lifecycle.** Evidence: [parallel task fields](/Users/traydr/dev/latch-works/apps/frame-view/src/main/thumbnail/ThumbnailBrokerService.ts:57), [creation](/Users/traydr/dev/latch-works/apps/frame-view/src/main/thumbnail/ThumbnailBrokerService.ts:344), [terminal paths](/Users/traydr/dev/latch-works/apps/frame-view/src/main/thumbnail/ThumbnailBrokerService.ts:637). Started/request/worker/timing fields and terminal updates are scattered. Use queued/running/terminal variants and one terminal transition. Extend stale-response, cancellation, crash and restart tests. Confidence: high.

- **F04-A, persist one window snapshot.** Evidence: [two observations](/Users/traydr/dev/latch-works/apps/frame-view/src/main/services/windowStatePersistence.ts:42), [close sequence](/Users/traydr/dev/latch-works/apps/frame-view/src/main/windowLifecycle.ts:35). Maximized and bounds are captured across an await, and close writes three times. Capture once and call one `updateWindowState`. Disk shape is unchanged. Test one write, correct normal bounds and event bursts. Confidence: high.

- **F04-B, one pending-flush record.** Evidence: [six correlated fields](/Users/traydr/dev/latch-works/apps/frame-view/src/main/services/settingsService.ts:38), [partial checks](/Users/traydr/dev/latch-works/apps/frame-view/src/main/services/settingsService.ts:186). Replace only the correlated private fields with one pending record/revision or idle/scheduled/writing state; keep the service interface and avoid a generic persistence coordinator. Test update-during-write, rejection/retry and batch settlement. Confidence: medium-high.

- **F05-A, preserve bridge `Result` through orchestration.** Evidence: [shared result](/Users/traydr/dev/latch-works/apps/frame-view/src/shared/types.ts:76), [two renderer clients](/Users/traydr/dev/latch-works/apps/frame-view/src/renderer/services/frameViewClient.ts:18), [error collapse](/Users/traydr/dev/latch-works/apps/frame-view/src/renderer/utils/frameViewResult.ts:5). Null/boolean adapters conflate cancellation, missing data and IPC failure, allowing navigation mutation before scan acceptance. Use one result-bearing renderer client and interpret outcomes at use-case boundaries. Add failed-start, empty-folder and missing-metadata tests. Confidence: high.

- **F05-B, discriminated renderer scan state.** Evidence: [parallel fields](/Users/traydr/dev/latch-works/apps/frame-view/src/renderer/store/types.ts:10), [manual transitions](/Users/traydr/dev/latch-works/apps/frame-view/src/renderer/store/scanState.ts:11). Loading can lack a run ID and terminal states can retain chunks/counters. Use loading with run ID/message/chunks and terminal variants; remove unread counters while retaining final items and viewer snapshot. Extend stale-run, warning, cancellation and terminal-cleanup tests. Confidence: high.

- **F07-A, keyed video-metadata overlay.** Evidence: [queue identity](/Users/traydr/dev/latch-works/apps/frame-view/src/renderer/hooks/useVideoMetadataQueue.ts:20), [three array scans](/Users/traydr/dev/latch-works/apps/frame-view/src/renderer/store/metadataState.ts:56). Each probe copies final items, loading chunks and viewer snapshot. Keep one local overlay keyed by media identity/fingerprint, resolved only at tile/viewer seams; do not normalize the store. Add stale-generation, fingerprint, dedupe and viewer tests. Confidence: medium-high.

### Gather Box

- **G01-A, remove four unused collector fields.** Evidence: [payload schema](/Users/traydr/dev/latch-works/apps/gather-box/src/shared/types.ts:4), [downloader consumption](/Users/traydr/dev/latch-works/apps/gather-box/src/gather/downloader.ts:102). Eleven collectors manufacture `pageNumber`, `thumbnailUrl`, `galleryId` and `skippedCount`, but downstream execution never reads them. Remove exactly those fields, preserve array order and legacy-read leniency. Update collector, queue and retry fixtures. Confidence: high.

- **G01-B, runtime-validate collector responses.** Evidence: [message interface](/Users/traydr/dev/latch-works/apps/gather-box/src/shared/messages.ts:8), [unused result schema](/Users/traydr/dev/latch-works/apps/gather-box/src/shared/types.ts:87), [trusted response](/Users/traydr/dev/latch-works/apps/gather-box/src/gather/active-tab.ts:36). Use one response schema and adapter enforcing request ID, source and output identity; delete the handwritten parallel interface. Add malformed/mismatched response tests. Confidence: high.

- **G02-A, one persisted/runtime phase schema.** Evidence: [runtime phases](/Users/traydr/dev/latch-works/apps/gather-box/src/shared/gather-run.ts:12), [stored omission](/Users/traydr/dev/latch-works/apps/gather-box/src/shared/gather-run.ts:110), [saved cancellation](/Users/traydr/dev/latch-works/apps/gather-box/src/background/gather-run-coordinator.ts:156). A live cancelling job is filtered out on the next load. Preserve every valid phase in storage and put restart policy in recovery. Add parse-save round trips and cancel/event/next-dispatch tests. Confidence: high.

- **G02-B, queue results own run history and retries.** Evidence: [queue results](/Users/traydr/dev/latch-works/apps/gather-box/src/shared/gather-queue.ts:37), [separate last-run load](/Users/traydr/dev/latch-works/apps/gather-box/src/shared/gather-controller.ts:201), [mixed snapshot](/Users/traydr/dev/latch-works/apps/gather-box/src/shared/gather-controller.ts:604). Queue and legacy storage can describe different runs, enabling retry without a target. Derive displayed/latest/retryable views atomically from queue; retain a temporary read-only legacy fallback if required. Add mixed-run and migration tests. Confidence: high.

- **G03-A, explicit executor observation.** Evidence: [ambiguous null](/Users/traydr/dev/latch-works/apps/gather-box/src/background/offscreen-document.ts:58), [global recovery](/Users/traydr/dev/latch-works/apps/gather-box/src/background/gather-run-coordinator.ts:230). No document, idle, malformed and observation failure all become null; one active run suppresses reconciliation of every other job. Use idle/active/unknown and per-job reconciliation, with bounded retry for unknown and explicit orphan handling. Extend active/stale/orphan/busy tests. Confidence: medium-high.

- **G04-A, response MIME owns transformed filename.** Evidence: [speculative target](/Users/traydr/dev/latch-works/apps/gather-box/src/gather/media-transformer.ts:7), [prefetch skip](/Users/traydr/dev/latch-works/apps/gather-box/src/gather/downloader.ts:110), [known disagreement](/Users/traydr/dev/latch-works/apps/gather-box/src/gather/archive-media-policy.test.ts:24). Filename prediction can skip a GIF that should produce MP4. Fetch, then let one MIME-aware transform choose the output; final no-clobber/content hash stays authoritative. Add disagreement, abort and recovery cases. Confidence: high.

- **G04-B, failures retain exact source items.** Evidence: [failure result](/Users/traydr/dev/latch-works/apps/gather-box/src/gather/downloader.ts:38), [filename reconstruction](/Users/traydr/dev/latch-works/apps/gather-box/src/offscreen/executor.ts:183). Duplicate filenames cause successful items to be retried. Return source plus reason, derive counts and wire records, and preserve deterministic source order. Add duplicate-name and mixed-failure tests. Confidence: high.

- **G05-A, one exact side-panel view.** Evidence: [retired controller options](/Users/traydr/dev/latch-works/apps/gather-box/src/shared/gather-controller.ts:72), [optional popup model](/Users/traydr/dev/latch-works/apps/gather-box/src/gather/dom.ts:8), [Chrome baseline](/Users/traydr/dev/latch-works/apps/gather-box/manifest.base.json:6). The only production UI is the side panel, but popup-only options and global-document lookups remain. Use required `SidePanelElements` from the supplied document, remove retired popup controls and duplicated progress reset. Add actual-markup and non-global-document tests. Confidence: high.

### Lockstep desktop and CLI

- **L01-A, commit profiles after persistence.** Evidence: [mutate-before-save](/Users/traydr/dev/latch-works/apps/lockstep/src/main/services/profileService.ts:145), [ignored migration save](/Users/traydr/dev/latch-works/apps/lockstep/src/main/services/profileService.ts:287). Failed creates, updates, deletes and token changes remain visible in memory. Build a candidate, persist it, then commit live state and session tokens. Add forced-write-failure tests for every mutation. Confidence: high.

- **L01-B, exact token state.** Evidence: [four-state computation](/Users/traydr/dev/latch-works/apps/lockstep/src/main/services/profileService.ts:123), [three booleans](/Users/traydr/dev/latch-works/apps/lockstep/src/shared/contracts.ts:112). The IPC model permits eight combinations and renderer code reconstructs precedence. Expose `none | secure | session | unreadable`; no disk migration is needed. Test all four renderer and run-gate outcomes. Confidence: high.

- **L02-A, one renderer run reducer.** Evidence: [parallel lifecycle fields](/Users/traydr/dev/latch-works/apps/lockstep/src/renderer/hooks/controller/types.ts:16), [status regex](/Users/traydr/dev/latch-works/apps/lockstep/src/renderer/hooks/controller/useLockstepController.ts:83), [competing terminal mutations](/Users/traydr/dev/latch-works/apps/lockstep/src/renderer/hooks/controller/useLockstepController.ts:151). Events and invoke promises can overwrite cancellation with error. After L03-B and S05-B, use idle/active/finished reducer variants and make status prose display-only. Add pure sequence tests. Confidence: high.

- **L02-B, one navigation owner.** Evidence: [controller screen](/Users/traydr/dev/latch-works/apps/lockstep/src/renderer/hooks/controller/types.ts:14), [local tab](/Users/traydr/dev/latch-works/apps/lockstep/src/renderer/components/AppLayout.tsx:38), [contradictory updates](/Users/traydr/dev/latch-works/apps/lockstep/src/renderer/components/AppLayout.tsx:102). Visible content and Review highlighting can disagree. Use one profile/dashboard/plan/log union and remove `run` from navigation. Test tab, profile and run-start behavior. Confidence: high.

- **L03-A, resolved command union.** Evidence: [permissive options](/Users/traydr/dev/latch-works/apps/lockstep-cli/src/types.ts:1), [repeated missing-field logic](/Users/traydr/dev/latch-works/apps/lockstep-cli/src/options.ts:211), [execution rechecks](/Users/traydr/dev/latch-works/apps/lockstep-cli/src/commands.ts:79). Keep permissive raw argv/config input, but resolve into doctor/plan/verify/push/prune variants before execution. Preserve precedence and secret non-persistence. Add per-command table tests. Confidence: high.

- **L03-B, structured item-progress events.** Evidence: [free-form event](/Users/traydr/dev/latch-works/packages/lockstep-core/src/types.ts:43), [CLI regex](/Users/traydr/dev/latch-works/apps/lockstep-cli/src/commands.ts:292), [renderer regex](/Users/traydr/dev/latch-works/apps/lockstep/src/renderer/hooks/controller/useLockstepController.ts:81). Paths with parentheses and deleting/registering stages are misparsed. Add a structured stage/current/total/path/detail event and reserve status for prose. Land producer, CLI and desktop consumers together; preserve rendered stderr if externally consumed. Confidence: high.

### Showcase

- **W01-A, derive product metadata from one existing registry.** Evidence: [parallel arrays](/Users/traydr/dev/latch-works/apps/showcase/src/data/products.ts:28), [positional join](/Users/traydr/dev/latch-works/apps/showcase/src/components/colorblock/Home.astro:27). Stage/order/enamel can drift. Fold those facts into existing product entries and derive ordered lookups; keep page-specific content and Astro dispatch local rather than creating a giant union. Add unique-slug and route-coverage checks. Confidence: high.

- **W01-B, validated docs sections.** Evidence: [free-form frontmatter](/Users/traydr/dev/latch-works/apps/showcase/src/content.config.ts:4), [first-seen order](/Users/traydr/dev/latch-works/apps/showcase/src/data/docs-nav.ts:9), [separate accent map](/Users/traydr/dev/latch-works/apps/showcase/src/components/DocsSidebarNav.astro:11). Thirty-two pages repeat section facts. Use stable section IDs with registry-owned label/order/accent, consuming W01-A product metadata where relevant. Preserve URLs; validate IDs and duplicate page order. Confidence: high.

- **W02-A, retire obsolete mocked previews.** Evidence: [canonical capture policy](/Users/traydr/dev/latch-works/apps/showcase/README.md:19), [Frame mock](/Users/traydr/dev/latch-works/apps/frame-view/src/showcase/mockFrameView.ts:69), [Lockstep mock](/Users/traydr/dev/latch-works/apps/lockstep/src/showcase/screens.tsx:19). Published artifacts use real apps; the mocked stacks have no documented or capture caller. Confirm no informal developer use, then remove both preview trees/configs/scripts and Frame’s preview-only production path. Run real captures and compare output. Confidence: high.

- **W02-B, transactional Electron capture session.** Evidence: [Frame launch/restore](/Users/traydr/dev/latch-works/apps/showcase/scripts/capture-frame-view.mjs:64), [Lockstep duplicate](/Users/traydr/dev/latch-works/apps/showcase/scripts/capture-lockstep.mjs:133). Process, CDP and user-file rollback logic has two subtly different owners. After W02-A, share only session cleanup and byte-identical file snapshot/restore; keep selectors, arguments and readiness local. Test stale backup, absent file, thrown callback, timeout and restoration. Confidence: high.

## 4. Explicit subsystem skips

- **S06:** Vendored Shutter mirrors cannot be locally simplified. Pane should consume `normalizeWidth` from the vendored public contract, but any package change belongs upstream.
- **P09:** Ordering, cursor variants, two-phase comic loading, query helpers, collation, migration harness and soft deletion are proportionate. Stale folder-count cleanup is part of P06-A, not a separate abstraction.
- **F06:** Folder child, sibling and overlay requests already suppress stale responses and have different breadcrumb/loading semantics. A shared hook would relocate request-token code.
- **I03:** Documentation, governance, static assets and inactive placeholders contain no executable state/control model. They were used as semantic constraints for runtime findings.

Every recommend row also recorded local skips. Common examples include intentional Electron process boundaries, test adapters with two real implementations, small direct UI code, bounded scans where indexes are unnecessary, and state machines that would only rename existing branches.

## 5. Cross-cutting patterns

- Persisted and runtime schemas disagree on transient lifecycle states.
- Terminal outcomes are independently derived for persistence, events and callers.
- Async work often lacks a stable identity through awaits or cancellation.
- Debounced persistence sometimes lacks an in-flight serialization owner.
- Typed transport results are weakened into null/boolean at renderer boundaries.
- Static configuration is sometimes copied into effect-driven lifecycle state.
- Opaque string keys combine several identities without injective serialization.
- Speculative polymorphism and history tables remain after all live consumers narrowed to one case.
- Registries exist without owning the transports or interfaces that repeat their data.
- Cleanup workers compensate for missing database relationships.
- Test fixtures can keep dead interfaces alive or mask production state drift.
- Client/server types drift when both sides redeclare the same wire result.

## 6. Rejected, duplicate and superseded findings

Rejected after the independent materiality pass:

- P01-B, duplicate PostCSS adapter: valid five-line cleanup, not material.
- P05-B, shared viewport store: comparable machinery to the current small hook.
- P09-A, folder counts as a standalone finding: folded into P06-A.
- P10-A, shared sync-protocol package: too broad; it would mix transport facts with Pane security normalization.
- F01-B, duplicate diagnostics fields: correct cleanup, below threshold.
- F06-B, generic folder-list hook: relocates lifecycle code across callers with different semantics.
- F07-B, leaf settings patches: correct minor call-site fix, below threshold.
- G05-B, build-artifact descriptor registry: mainly relocates a small map and loop.

Other deduplication decisions:

- G03’s cancelling-phase finding was identical to G02-A; G02 owns it.
- P08-B owns viewer progress shape; P04-B owns write ordering.
- L03-B owns structured progress events; S04-B remains scan-event throttling; L02-A owns renderer lifecycle.
- P11-A owns repository delivery context; P06-B owns the external transport result.
- F06’s proposal to adopt shared `BrowserEntry` was rejected because S01-B removes that shared model and Frame’s chunk-aware semantics differ.
- W02-A supersedes the earlier decision merely to leave desktop showcase mocks alone.
- A suggested P03-A to S01-B dependency was rejected. P03-A’s five dead modules are unrelated to the active browser-entry seam.

## 7. Dependencies

Causal dependencies:

- P08-B → P04-B
- F04-A → F04-B
- F02-A → F02-B
- L03-B and S05-B → L02-A
- L03-B → L03-A
- P11-A → P06-B
- S03-B → P11-B
- W01-A → W01-B
- W02-A → W02-B

Coordination bundle, not a causal chain:

- P08-A, P10-B and P12-A should share one Pane migration release because all touch schema or cleanup-worker behavior.

## 8. Audit log

1. Established 38 exact subsystem rows.
2. Reviewed subsystems in three bounded, non-overlapping worker lanes.
3. Independently checked every proposed finding against current implementation and call sites.
4. Added explicit local skips for every reviewed row.
5. Deduplicated Gather cancellation, viewer-state, media-delivery and Lockstep progress concerns.
6. Rejected the Frame/shared-browser contradiction.
7. Ran a complete tracked-file coverage pass over 880 files; no missing row remained.
8. Ran an ownership-overlap pass and converted overlaps into dependencies.
9. Ran a schema-completeness pass; corrected the stable F06-A/F06-B identity.
10. Ran a materiality pass; removed eight weak or over-broad candidates and converted P09/F06 to skips.
11. Ran a dependency-aware ranking pass; corrected inflated impact/effort and false causal edges.
12. Verified the repository remained clean.

Final verification:

```text
git status --porcelain=v1 --untracked-files=all
# no output

git diff --stat
# no output

git rev-parse HEAD
be776cbd8b13ed174357dc1fc56b96d13471b4d2
```