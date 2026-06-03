# Latch Works Progress

Last updated: 2026-06-03

## Current Phase

The project is now in **Phase 7: Feature Parity and Polish** for Pane View.

Phase 6 deployment work is being skipped in local implementation notes because deployment has already happened. The current focus is improving the DB-backed Pane View browsing/viewing experience after the auth, sync, storage, and ingest baseline.

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
- Added a database repository for future Pane View library loading.
- Routed the Pane View library loader through a server function that reads from the Postgres library repository when `DATABASE_URL` is configured and falls back to fixtures for local prototype use.
- Added Pane View login route and auth API route scaffolding.
- Added single-user session helper primitives.
- Added Postgres-aware session storage helpers for login, logout, and media-route session validation. These fall back to prototype cookie acceptance when `DATABASE_URL` is not configured.
- Added a server-side Pane View route guard so the website shell redirects unauthenticated users to `/login` before archive data loads.
- Added a logout control in the protected Pane View toolbar that revokes the stored session and clears the session cookie.
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
- Replaced the original media route placeholder with DB-backed media lookup from `library_entries` and `media_objects`.
- Added real selected-media rendering in Pane View for synced UUID media:
  - images use the authenticated original route,
  - videos use native browser controls,
  - PDF/story entries use a framed browser viewer,
  - fixture/prototype entries keep placeholder previews.
- Added path/search browsing for DB-backed Pane View:
  - `path` and `q` search params,
  - clickable root/folder navigation,
  - DB and fixture filtering by path/name,
  - recursive media loading under the selected path.
- Added selected media deep-linking through the `media` search param.
- Added viewer resume-state plumbing:
  - current session user lookup from stored DB sessions,
  - viewer-state server functions over the existing `viewer_state` table,
  - video position save/restore through native video events,
  - read/view state display in the selected-media metadata panel.
- Improved sync-ingest folder creation so Lockstep-created library entries also upsert the full folder chain needed for path navigation.
- Added authenticated thumbnail delivery:
  - `/api/media/$mediaId/thumbnail`,
  - DB lookup for ready thumbnail records,
  - signed storage redirect when bucket credentials are configured,
  - optional grid thumbnail rendering when the library snapshot includes a ready thumbnail URL.
- Added a capped Lockstep push option for safer first sync testing:
  - `--max-changes <count>`,
  - documented in `docs/runbooks/lockstep.md`.
- Added S3-compatible storage adapter for signed GET/PUT URLs. This is intended to work with Railway Buckets first and can also fit S3/R2-style storage later.
- Added a dedicated Pane View Vitest config so package unit tests run without loading the TanStack/Vite app plugin stack.
- Added placeholder app folders for future imports:
  - `apps/frame-view`,
  - `apps/gather-box`.
- Imported Frame View from `C:\Users\Trayd\dev\frame-view` into `apps/frame-view`.
- Imported Content Downloader from `C:\Users\Trayd\dev\comic-downloader` into `apps/gather-box`.
- Renamed the imported extension surface to Gather Box without changing collector behavior.
- Recorded Phase 0 decisions in `docs/decisions/0001-phase-0-answers.md`.
- Added Lockstep usage notes in `docs/runbooks/lockstep.md`.
- Added Lockstep interactive mode:
  - zero-arg and missing-flag prompts via `@inquirer/prompts`,
  - user config at `~/.latch-works/lockstep.json`,
  - `LOCKSTEP_SOURCE` env override,
  - `--yes` for non-interactive push,
  - verify drift exit code and required `--remote-snapshot`,
  - doctor API snapshot connectivity check.
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
- The earlier custom DB env helper was reverted and replaced with the project-standard t3env pattern:
  - Pane View now has `src/env/server.ts`,
  - Drizzle imports `env` from that module,
  - migrations use `env.DATABASE_URL` as the only DB URL source.
- Replaced the hand-written initial SQL file with a Drizzle-generated migration plus `drizzle/meta` journal/snapshot files so `drizzle-kit migrate` has the metadata it expects.
- Pane View auth route guard tests pass.
- Pane View production build passes after moving the library loader behind a server function.
- Full workspace `pnpm check` passes after moving Pane View behind auth.
- Local HTTP verification confirmed:
  - anonymous `/` redirects to `/login`,
  - valid login returns a session cookie and redirects to `/`,
  - authenticated `/` returns the protected Pane View shell with the sign-out control.
- Local HTTP/browser verification after Phase 7 browsing work confirmed:
  - `/api/health` returns OK,
  - authenticated `/?path=...&q=...` renders the protected Pane View shell,
  - the selected `media` search param is accepted without browser console errors,
  - authenticated missing media originals return `404` instead of placeholder signed URLs.
- Pane View focused checks pass after the Phase 7 updates:
  - `pnpm --filter @latch-works/pane-view typecheck`,
  - `pnpm --filter @latch-works/pane-view test`,
  - `pnpm --filter @latch-works/pane-view build`,
  - `pnpm lint`.
- Lockstep readiness checks:
  - `pnpm lockstep -- doctor` runs locally,
  - `pnpm lockstep -- plan --source "T:\cloud-desktop\media"` completed read-only,
  - `pnpm lockstep -- --help` exits successfully,
  - the local authenticated `/api/sync/snapshot` endpoint returned `200`.

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

1. Run a capped Lockstep push against the deployed endpoint or a small test source before syncing the full archive:
   - `pnpm lockstep -- push --source "T:\cloud-desktop\media" --max-changes 25`.
2. Add actual thumbnail generation/upload during Lockstep sync or a derived-media worker:
   - generate image thumbnails,
   - generate video posters,
   - generate PDF/story covers,
   - insert rows into `thumbnails`.
3. Improve mobile viewing ergonomics:
   - touch-friendly selected-media viewer,
   - swipe previous/next in the viewer,
   - better small-screen toolbar behavior.
4. Add sidecar/ancillary metadata support:
   - ingest `meta.json` as metadata,
   - associate `.srt` with videos,
   - decide whether `.txt`, `.zip`, `.vrm`, `.me`, and scripts become attachments or remain ignored.
   Current decision: ignore these files for first sync, except keep `meta.json` noted as future site-specific metadata.
5. Harden auth beyond the current single-user/session baseline:
   - add CSRF checks for non-GET web requests,
   - add login rate limiting,
   - add first-run credential setup or documented Railway secret requirements.

## Current Status

The foundation is healthy and verified. Pane View has auth/session/storage/sync scaffolding, the website shell is behind auth, Lockstep can push to the sync API, and Phase 7 work has started with DB-backed browsing, selected-media rendering, and resume-state plumbing.
