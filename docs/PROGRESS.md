# Latch Works Progress

Last updated: 2026-06-02

## Current Phase

The project is between **Phase 1: Latch Works Bootstrap** and **Phase 3: Pane View Prototype** from the architecture plan.

Phase 0 is complete because the open architecture questions have been answered and recorded. Phase 1 is partially complete because the monorepo foundation exists, but Frame View and Gather Box have not yet been imported into `apps/frame-view` and `apps/gather-box`. Phase 3 has started because Pane View already has a runnable fixture-backed browsing prototype.

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
- Added placeholder app folders for future imports:
  - `apps/frame-view`,
  - `apps/gather-box`.
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

1. Import the existing Frame View working tree into `apps/frame-view` without refactoring it.
2. Import the existing Content Downloader working tree into `apps/gather-box` and rename the app/package surface to Gather Box.
3. Add fixture-backed route loaders/server functions to Pane View instead of keeping all fixture data in the route component.
4. Add the first database schema draft with Drizzle/Postgres for users, sessions, media objects, library entries, folders, and sync runs.
5. Add single-user auth around Pane View routes and every server function/media route.
6. Add Lockstep remote API configuration and keep `push` disabled until ingest endpoints and token auth exist.
7. Decide sidecar/ancillary file policy:
   - ingest `meta.json` as metadata,
   - associate `.srt` with videos,
   - decide whether `.txt`, `.zip`, `.vrm`, `.me`, and scripts become attachments or remain ignored.
8. Replace Pane View fixture data with database-backed folder/media browsing.
9. Add Railway bucket client wiring and signed URL media route prototypes.

## Current Status

The foundation is healthy and verified. The project is ready for the first consolidation step: importing Frame View and Gather Box, while keeping the current scaffold green.
