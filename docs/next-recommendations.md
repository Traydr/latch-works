# Latch Works Next Recommendations

This document captures the direction recommendations from the `/improve next` pass. It is
roadmap guidance, not an implementation plan. Each item is grounded in current code or docs and
can be turned into a separate self-contained plan later.

## Recommended Order

1. Ship PDF cover previews.
2. Implement the Gather Box sidecar metadata pipeline.
3. Productize favorites, bookmarks, and read state.
4. Make Pane View installable as an online-only PWA.
5. Add targeted derivative prewarm after PDF covers.
6. Make sync tokens first-class on the server.

## Dependency Notes

- Targeted derivative prewarm should follow PDF cover previews, so prewarm can cover PDFs along
  with images, GIFs, and videos.
- Source-aware search and source-post collections should follow sidecar ingestion. The current
  library query is path/name-first, so there is no reliable source metadata to search until the
  Gather Box -> Lockstep -> Pane View metadata path exists.
- Server-side sync token management can be planned independently, but it becomes more valuable
  once multiple Lockstep profiles, environments, or client machines are actively used.

## 1. Ship PDF Cover Previews

**Product value:** PDF/story entries become visually scannable in Pane View instead of appearing
as generic file placeholders. This closes one of the few remaining gaps in the media grid for a
core supported media type.

**Evidence:**

- `docs/derivative-prewarm-and-workers.md:196` recommends on-demand PDF cover previews as the
  next build plan.
- `packages/media-storage/src/index.ts:40` already supports `previewObjectKey` paths for PDF
  previews.
- `apps/pane-view/src/server/media/derivative-service.ts:323` currently supports derivatives only
  for image, GIF, and video.
- `apps/pane-view/src/features/gallery/Poster.tsx:15` treats PDF as a non-thumbnail media type,
  so cards fall back to a placeholder.

**Trade-offs:** Server-side PDF rendering adds a Node canvas or rasterizer dependency and needs
careful tests for encrypted, corrupt, or oversized PDFs. The upside is high because it reuses the
existing thumbnail state machine, CDN delivery, and storage key model.

**Coarse effort:** Medium.

## 2. Implement The Gather Box Sidecar Metadata Pipeline

**Product value:** Source titles, creators, post IDs, original URLs, skipped counts, and chapter
metadata can survive the trip from browser collection into the local archive and Pane View. This
enables source-aware search, source-post collections, and better story/gallery grouping without
scraping filenames later.

**Evidence:**

- `docs/gather-box-sidecar-manifests.md:3` states that sidecar writing and ingestion are not
  implemented yet.
- `apps/gather-box/src/shared/types.ts:12` already has collector payloads with source metadata.
- `apps/gather-box/src/shared/gather-controller.ts:429` writes downloaded files but not sidecar
  manifests.
- `packages/media-index/src/scan.ts:128` treats unsupported files as skipped entries, so sidecars
  are not consumed as metadata during scans.
- `apps/pane-view/src/server/db/schema.ts:234` and
  `apps/pane-view/src/server/db/schema.ts:255` already have source and collection fields that can
  receive richer metadata later.

**Trade-offs:** This is a multi-stage feature, not a single small patch. It should start with an
optional Gather Box writer and shared validation before touching Lockstep payloads or Pane View
storage. The privacy rules in the sidecar design should be treated as hard requirements.

**Coarse effort:** Large.

## 3. Productize Favorites, Bookmarks, And Read State

**Product value:** Pane View becomes a personal library surface, not just a browser. The owner can
mark favorite media or collections, return to partially read/watched items, and distinguish read
or viewed content across devices.

**Evidence:**

- `docs/ARCHITECTURE_PLAN.md:103` lists favorites, bookmarks, and read state as should-have
  product scope.
- `apps/pane-view/src/server/db/schema.ts:346` defines `viewer_state`.
- `apps/pane-view/src/server/db/schema.ts:363` defines `favorites`.
- `apps/pane-view/src/features/gallery/MediaViewerModal.tsx:93` wires viewer state for video and
  PDF subjects.
- `apps/pane-view/src/server/management/library-wipe.ts:47` cleans up favorites, but there is no
  visible favorite workflow in the gallery.

**Trade-offs:** Resume state has moved ahead of the docs, so the next plan should not redo that
work. It should add the missing user-facing favorite/bookmark/read-state flows and keep the schema
compatible with future collection subjects.

**Coarse effort:** Medium.

## 4. Make Pane View Installable As An Online-Only PWA

**Product value:** Pane View would feel more native on iPad and iPhone without taking on full
offline sync. This fits the current product stance: remote access is private and read-only, while
the local archive remains the source of truth.

**Evidence:**

- `docs/ARCHITECTURE_PLAN.md:103` lists PWA installability for iPad/iPhone as should-have scope.
- `docs/ARCHITECTURE_PLAN.md:116` explicitly keeps full mobile offline sync out of first-version
  scope.
- `apps/pane-view/src/routes/__root.tsx:19` currently declares only basic head metadata, favicon,
  and stylesheet links.
- `apps/pane-view/public/` currently contains only `favicon.svg`.

**Trade-offs:** Keep this installability-first. Add a web manifest, icons, mobile app metadata,
and smoke tests for the installed browser chrome. Avoid caching private originals or building
offline media sync until there is a deliberate security and storage design.

**Coarse effort:** Small.

## 5. Add Targeted Derivative Prewarm After PDF Covers

**Product value:** Recently synced or operator-selected folders can open with fewer thumbnail
generation waits. This is especially useful after large pushes and keeps the first browser visit
from paying all derivative costs on the request path.

**Evidence:**

- `docs/derivative-prewarm-and-workers.md:115` recommends targeted prewarm triggers rather than an
  always-on worker.
- `docs/derivative-prewarm-and-workers.md:231` sequences PDF covers before Lockstep prewarm.
- `apps/pane-view/src/features/management/ManagementPage.tsx:179` already has a thumbnail
  management surface.
- `apps/pane-view/src/server/management/retry-failed-thumbnails.ts:9` already has management code
  that loops over thumbnail rows and calls regeneration.

**Trade-offs:** Prewarm increases origin CPU and sync or management-operation duration. It should
start as an explicit folder or sync-run action, reuse the existing thumbnail state machine, and
avoid introducing a background worker until there are metrics showing the web tier needs one.

**Coarse effort:** Medium.

## 6. Make Sync Tokens First-Class On The Server

**Product value:** Pane View can rotate, revoke, name, and audit sync clients instead of relying
on one environment-wide bearer token. This pairs naturally with Lockstep desktop profiles and
future multi-machine or production/dev workflows.

**Evidence:**

- `apps/pane-view/src/server/db/schema.ts:127` defines an `api_tokens` table with token hashes,
  scopes, last-used timestamps, and revocation.
- `apps/pane-view/src/server/db/schema.ts:170` includes `createdByTokenId` on sync runs.
- `apps/pane-view/src/server/auth/api-token.ts:26` still validates sync requests against a single
  `PANE_VIEW_SYNC_TOKEN` environment value.
- `apps/lockstep/src/main/services/profileService.ts:81` already supports per-profile token
  storage on the desktop client.

**Trade-offs:** This is operational maturity, not the most visible user feature. Keep an
environment-token fallback during migration, add management UI or CLI affordances for token
creation/revocation, and make sure token values are shown only once at creation time.

**Coarse effort:** Medium.

## Suggested Plan Set

Turn these into implementation plans first:

1. PDF cover previews.
2. Gather Box sidecar metadata pipeline.
3. Favorites, bookmarks, and read state.
4. Online-only PWA installability.

Then follow with targeted derivative prewarm. Server-side token management can be scheduled when
token rotation, multiple clients, or environment separation becomes a near-term operational need.
