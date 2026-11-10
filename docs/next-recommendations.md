# Latch Works Next Recommendations

This document captures the direction recommendations from the `/improve next` pass. It is
roadmap guidance, not an implementation plan. Each item is grounded in current code or docs and
can be turned into a separate self-contained plan later.

## Recommended Order

1. Implement the Gather Box sidecar metadata pipeline.
2. Productize favorites, bookmarks, and read state.
3. Make Pane View installable as an online-only PWA.
4. Make sync tokens first-class on the server.

## Dependency Notes

- Source-aware search and source-post collections should follow sidecar ingestion. The current
  library query is path/name-first, so there is no reliable source metadata to search until the
  Gather Box -> Lockstep -> Pane View metadata path exists.
- Server-side sync token management can be planned independently, but it becomes more valuable
  once multiple Oriel Sync profiles, environments, or client machines are actively used.

Pane View's image, video, and PDF renditions are provided by Shutter. Do not add a Pane-side
derivative queue, worker, storage layout, or prewarm feature; `docs/ARCHITECTURE.md` defines
Shutter as the sole rendition provider.

## 1. Implement The Gather Box Sidecar Metadata Pipeline

**Product value:** Source titles, creators, post IDs, original URLs, skipped counts, and chapter
metadata can survive the trip from browser collection into the local archive and Pane View. This
enables source-aware search, source-post collections, and better story/gallery grouping without
scraping filenames later.

**Evidence:**

- `docs/gather-box-sidecar-manifests.md:3` states that sidecar writing and ingestion are not
  implemented yet.
- `apps/gather-box/src/shared/types.ts:12` already has collector payloads with source metadata.
- `apps/gather-box/src/shared/archive-writer.ts:92` writes downloaded files but not sidecar
  manifests.
- `packages/lockstep-core/src/scan.ts:320` treats unsupported files as skipped entries, so sidecars
  are not consumed as metadata during scans.
- Pane View has no source or collection fields to receive the metadata: migration
  `0022_drop_dead_schema.sql` dropped the unused `sources` and `collections` tables and the
  `library_entries.source*` columns.

**Trade-offs:** This is a multi-stage feature, not a single small patch. It should start with an
optional Gather Box writer and shared validation before touching Lockstep payloads or Pane View
storage. The privacy rules in the sidecar design should be treated as hard requirements.

**Coarse effort:** Large.

## 2. Productize Favorites, Bookmarks, And Read State

**Product value:** Pane View becomes a personal library surface, not just a browser. The owner can
mark favorite media or collections, return to partially read/watched items, and distinguish read
or viewed content across devices.

**Evidence:**

- `apps/pane-view/src/server/db/schema.ts:231` defines `viewer_state`, one row per library entry.
- `apps/pane-view/src/features/viewer/MediaViewerSession.tsx:368` wires viewer state for video and
  PDF subjects.
- There is no favorite workflow: migration `0022_drop_dead_schema.sql` dropped the unused
  `favorites` table.

**Trade-offs:** Resume state has moved ahead of the docs, so the next plan should not redo that
work. It should add the missing user-facing favorite/bookmark/read-state flows and their schema.

**Coarse effort:** Medium.

## 3. Make Pane View Installable As An Online-Only PWA

**Product value:** Pane View would feel more native on iPad and iPhone without taking on full
offline sync. This fits the current product stance: remote access is private and read-only, while
the local archive remains the source of truth.

**Evidence:**

- `apps/pane-view/src/routes/__root.tsx:11` currently declares only basic head metadata, favicon,
  apple-touch-icon, and stylesheet links.
- `apps/pane-view/public/` currently contains only the favicons and `apple-touch-icon.png`.

**Trade-offs:** Keep this installability-first. Add a web manifest, icons, mobile app metadata,
and smoke tests for the installed browser chrome. Avoid caching private originals or building
offline media sync until there is a deliberate security and storage design.

**Coarse effort:** Small.

## 4. Make Sync Tokens First-Class On The Server

**Product value:** Pane View can rotate, revoke, name, and audit sync clients instead of relying
on one environment-wide bearer token. This pairs naturally with Oriel Sync's profiles and future
multi-machine or production/dev workflows.

**Evidence:**

- `apps/pane-view/src/server/auth/api-token.ts:32` validates sync requests against a single
  `PANE_VIEW_SYNC_TOKEN` environment value. The unused `api_tokens` table and
  `sync_runs.created_by_token_id` were dropped in migration `0022_drop_dead_schema.sql`, so token
  storage starts from scratch.
- `apps/oriel/crates/mode-sync/src/profiles.rs:1` already stores a token per profile on the
  desktop client.

**Trade-offs:** This is operational maturity, not the most visible user feature. Keep an
environment-token fallback during migration, add management UI or CLI affordances for token
creation/revocation, and make sure token values are shown only once at creation time.

**Coarse effort:** Medium.

## Suggested Plan Set

Turn these into implementation plans first:

1. Gather Box sidecar metadata pipeline.
2. Favorites, bookmarks, and read state.
3. Online-only PWA installability.

Server-side token management can be scheduled when token rotation, multiple clients, or environment
separation becomes a near-term operational need.
