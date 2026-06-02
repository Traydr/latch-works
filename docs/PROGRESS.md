# Latch Works Progress

Last updated: 2026-06-02

## Current Phase

The project is between **Phase 1: Latch Works Bootstrap** and **Phase 3: Pane View Prototype** from the architecture plan.

Phase 0 is complete because the open architecture questions have been answered and recorded. Phase 1 is now materially complete because the monorepo foundation exists and Frame View/Gather Box have been imported under `apps/`. Phase 3 has started because Pane View already has a runnable fixture-backed browsing prototype, and the backend sync/storage path is now ready for a real deployment environment.

## Work Completed

- Created the pnpm monorepo workspace.
- Added shared TypeScript, Biome, Vitest, and workspace scripts.
- Added the initial Pane View TanStack Start app under `apps/pane-view`.
- Added a path-first Pane View browser surface with:
  - archive root/sidebar navigation,
  - current path chrome,
  - recursive mode toggle,
  - comic grouping toggle,
  - sort controls,
  - fixture-backed media/folder/comic entries,
  - selected media preview/metadata panel,
  - `/api/health`.
- Added `packages/media-domain` for:
  - supported media extension detection,
  - archive path helpers,
  - Frame View-style numeric sorting,
  - random sort seeding,
  - comic grouping,
  - browser entry construction.
- Added `packages/media-index` for:
  - recursive local archive scanning,
  - optional sha256 hashing,
  - path-preserving scan results,
  - sync plan creation for upload/update/keep/delete.
- Added `packages/media-storage` for:
  - content-addressed original object keys,
  - thumbnail keys,
  - preview keys,
  - sync manifest keys.
- Added `tools/lockstep` CLI scaffold with:
  - `plan`,
  - `verify`,
  - `doctor`,
  - guarded `push` placeholder,
  - `--show-skipped` reporting for skipped local files.
- Added Lockstep remote configuration parsing:
  - `--api-url`,
  - `--api-token-env`,
  - `LOCKSTEP_API_URL`,
  - `LOCKSTEP_API_TOKEN`.
- Added Pane View route-loader backed fixture library service.
- Added a database repository for future Pane View library loading. The UI remains fixture-backed until this is routed through a server-only boundary.
- Added Pane View login route and auth API route scaffolding.
- Added single-user session helper primitives.
- Added Postgres-aware session storage helpers for login, logout, and media-route session validation. These fall back to prototype cookie acceptance when `DATABASE_URL` is not configured.
- Added sync API token helper primitives.
- Added initial Drizzle/Postgres schema draft for users, sessions, API tokens, media objects, library entries, folders, collections, thumbnails, sync runs, viewer state, and favorites.
- Added Pane View Drizzle config and initial SQL migration.
- Added a Postgres adapter and server-side library repository boundary.
- Added sync API stubs for:
  - `/api/sync/runs`,
  - `/api/sync/upload-url`,
  - `/api/sync/complete-object`.
- Added database-backed sync ingest handling for:
  - creating sync runs,
  - upserting content-addressed media objects,
  - upserting path-preserving library entries,
  - marking missing local paths as remotely deleted,
  - recording sync run item activity.
- Wired Lockstep `push` to the Pane View sync API:
  - creates a sync run,
  - hashes files automatically,
  - requests signed upload URLs,
  - uploads originals when storage credentials are configured,
  - completes uploaded objects through the ingest API,
  - sends delete actions when local paths disappear.
- Added an authenticated remote sync snapshot endpoint so Lockstep can compare local files with the current Pane View library before push.
- Added authenticated media delivery route scaffold for `/api/media/$mediaId/original`.
- Added signed original delivery planning through content-addressed object keys.
- Added S3-compatible storage adapter for signed GET/PUT URLs. This is intended to work with Railway Buckets first and can also fit S3/R2-style storage later.
- Added placeholder app folders for future imports:
  - `apps/frame-view`,
  - `apps/gather-box`.
- Imported Frame View from `C:\Users\Trayd\dev\frame-view` into `apps/frame-view`.
- Imported Content Downloader from `C:\Users\Trayd\dev\comic-downloader` into `apps/gather-box`.
- Renamed the imported extension surface to Gather Box without changing collector behavior.
- Recorded Phase 0 decisions in `docs/decisions/0001-phase-0-answers.md`.
- Added Lockstep usage notes in `docs/runbooks/lockstep.md`.
- Updated the architecture plan open questions with the answered decisions.

## Verification Completed

- `pnpm lint` passes.
- `pnpm check` passes:
  - package builds,
  - Pane View production build,
  - tests,
  - TypeScript checks.
- Pane View dev server was started locally and `/api/health` returned OK.
- Browser DOM verification confirmed Pane View rendered the expected path-first UI content.
- Browser console error check returned no errors.
- Lockstep read-only scan against `T:\cloud-desktop\media` completed without writing to the archive.
- Imported Gather Box `check` passes.
- Imported Frame View typecheck, lint, and test suite pass. Frame View lint currently reports existing warnings but exits successfully.
- Pane View auth/session helper tests pass.
- Pane View sync API token helper tests pass.
- Pane View media delivery helper tests pass.
- Media storage S3 config helper tests pass.
- Pane View sync ingest API build/typecheck passes.
- Lockstep push CLI typecheck passes.
- Full workspace `pnpm check` passes after sync ingest/push wiring.
- Full workspace `pnpm check` passes after adding the remote snapshot endpoint.

## Archive Scan Result

Read-only command:

```powershell
pnpm lockstep -- plan --source "T:\cloud-desktop\media"
```

Result:

- Supported media files: `16,013`
- Skipped files: `242`
- Total supported media size: about `36 GB`
- Planned uploads with no remote snapshot: `16,013`
- Planned deletes with no remote snapshot: `0`

The skipped files are skipped because Lockstep currently syncs only supported image, video, animated image, and PDF/story formats.

## Skipped File Breakdown

By extension:

| Count | Extension | Meaning |
|---:|---|---|
| 166 | `.db` | Windows `Thumbs.db` thumbnail cache files |
| 55 | `.json` | `meta.json` sidecar metadata, mostly under `nsfw/nhentai` |
| 14 | `.txt` | Discord channel backup/link text files |
| 2 | `.srt` | Subtitle files |
| 1 | `.md` | Reddit reorganization instructions |
| 1 | `.me` | Qyuwi sound/asset file |
| 1 | `.ps1` | Discord backup helper script |
| 1 | `.vrm` | Qyuwi VRM model asset |
| 1 | `.zip` | Qyuwi desktop pal archive |

Important note: this does **not** mean any image, video, GIF, or PDF files were skipped. It means the current supported-media rules do not sync ancillary files yet.

To inspect every skipped path directly:

```powershell
pnpm lockstep -- plan --source "T:\cloud-desktop\media" --show-skipped
```

## Risk Notes

- The 55 `meta.json` files look useful and should probably become first-class sidecar metadata before the first serious sync.
- The Discord `.txt` files may matter if Pane View should support text/link archive browsing, not just PDF stories.
- The `.srt` files are related to videos and should probably be attached to their corresponding video entries once media metadata support is added.
- The `.zip`, `.vrm`, and `.me` files are not media viewer assets today. Decide whether Lockstep should store them as archive attachments or intentionally ignore them.
- `Thumbs.db` files are safe to ignore for Pane View.

## Next Planned Work

1. Provision deployment resources for a first online prototype:
   - Railway app service,
   - Postgres database,
   - Railway bucket or S3-compatible bucket,
   - production env vars/secrets.
2. Apply the initial Drizzle SQL migration to the deployed database.
3. Run a small Lockstep push against the deployed endpoint with a limited test folder before pushing the full archive. Lockstep will fetch the deployed remote snapshot automatically for push planning.
4. Route Pane View library loading through a server-only database boundary so the UI reads synced records instead of fixtures.
5. Keep sidecar/ancillary file policy simple for now:
   - ingest `meta.json` as metadata,
   - associate `.srt` with videos,
   - decide whether `.txt`, `.zip`, `.vrm`, `.me`, and scripts become attachments or remain ignored.
   Current decision: ignore these files for first sync, except keep `meta.json` noted as future site-specific metadata.
6. Add preview/thumbnail optimization after the first original-file sync path is proven.

## Current Status

The foundation is healthy and verified. Pane View has auth/session/storage/sync scaffolding, and Lockstep can now push to the sync API. This is at the deployment-prep boundary; Railway/resource setup should happen next with user involvement.
