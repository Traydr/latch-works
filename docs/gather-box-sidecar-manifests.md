# Gather Box Sidecar Manifests

> Design document — not implemented yet. Gather Box does not write these files today;
> Lockstep and Pane View do not ingest them yet.

## Problem

Gather Box already captures rich source-site metadata when it downloads galleries and
stories (`pageUrl`, `galleryId` / `storyId`, titles, authors, chapter lists, per-image
URLs). That context is lost once files exist only as sanitized folder and file names in
the local archive. Filename scraping is fragile and cannot recover skipped items,
original URLs, or chapter order.

A small, versioned sidecar manifest beside each download folder preserves that context
for Lockstep ingest and Pane View grouping/search without changing how binaries are named
today.

## Filename and placement

| Rule | Value |
| --- | --- |
| Filename | `.latch-works.source.json` |
| Location | Same directory as the downloaded media |
| Visibility | Leading dot hides the file on Unix-like systems; Windows may show it depending on explorer settings |

**Gallery example layout**

```text
archive-root/
  pixiv/
    patron/
      sample_post_title/
        .latch-works.source.json
        001.webp
        002.webp
```

**Story example layout**

```text
archive-root/
  fanfiction-net/
    Author_Name-Story_Title.pdf
    .latch-works.source.json
```

For single-file story PDFs, the sidecar sits in the same folder as the PDF (typically the
site folder, e.g. `fanfiction-net/`). For gallery downloads, the sidecar sits inside the
post folder next to numbered images.

The constant `GATHER_BOX_SOURCE_SIDECAR_FILENAME` in `@latch-works/media-domain` mirrors
this name for shared tooling.

## Schema overview

All manifests are JSON objects with a required `schemaVersion`. Version `1` is the
initial design.

| Field | Required | Description |
| --- | --- | --- |
| `schemaVersion` | yes | Integer schema version. Consumers must reject unknown major versions. |
| `outputKind` | yes | `"downloadable-files"` (gallery) or `"generated-story-pdf"` (story). |
| `site` | yes | Gather Box site key (see [Supported sources](/docs/supported-sources)). |
| `sourceUrl` | yes | Canonical page URL for the post or work (from collector `pageUrl`). |
| `sourceId` | gallery: optional; story: yes | `galleryId` or `storyId` when the site exposes one. |
| `title` | yes | Human title from the source page. |
| `creator` | story: yes; gallery: optional | Author or creator when known (`author` for stories). |
| `downloadedAt` | yes | ISO-8601 UTC timestamp when the download completed. |
| `gatherBoxVersion` | no | Extension version string when available. |
| `skippedCount` | no | Count of items the collector skipped (matches collector payload). |
| `files` | gallery: yes | Ordered list of downloaded image files. |
| `file` | story: yes | The single generated PDF entry. |
| `summary` | no | Story summary text when collected. |
| `chapters` | no | Chapter references for multi-chapter story merges. |

### File entry shape

Each `files[]` / `file` entry maps a collector item to the **basename** written on disk
(not an absolute path):

| Field | Required | Description |
| --- | --- | --- |
| `path` | yes | Downloaded filename relative to the sidecar directory (e.g. `001.webp`). |
| `index` | yes | 1-based sequence in the download set. |
| `originalUrl` | no | Remote URL used for the download when safe to store (see privacy). |
| `pageNumber` | no | Source page/chapter number when the collector tracked one. |

`path` must match the sanitized name Gather Box already writes (`fileName` from
`DownloadableFile`, or `buildStoryPdfFileName` output for stories). Lockstep and Pane View
should join sidecar directory + `path` to locate the binary under the archive root.

## Examples

Synthetic data only — do not treat these as real archive paths.

### Gallery (`downloadable-files`)

```json
{
  "schemaVersion": 1,
  "outputKind": "downloadable-files",
  "site": "pixiv",
  "sourceUrl": "https://example.invalid/pixiv/user/sample/post/1001",
  "sourceId": "1001",
  "title": "Sample_Post_Title",
  "downloadedAt": "2026-06-12T18:30:00.000Z",
  "gatherBoxVersion": "0.0.0-dev",
  "skippedCount": 0,
  "files": [
    {
      "path": "001.webp",
      "index": 1,
      "originalUrl": "https://cdn.example.invalid/files/a.webp",
      "pageNumber": 1
    },
    {
      "path": "002.webp",
      "index": 2,
      "originalUrl": "https://cdn.example.invalid/files/b.webp",
      "pageNumber": 2
    }
  ]
}
```

### Story (`generated-story-pdf`)

```json
{
  "schemaVersion": 1,
  "outputKind": "generated-story-pdf",
  "site": "fanfiction-net",
  "sourceUrl": "https://example.invalid/fanfiction/s/42/1/Sample_Story",
  "sourceId": "42",
  "title": "Sample Story",
  "creator": "Sample Author",
  "summary": "A short synthetic summary for design review.",
  "downloadedAt": "2026-06-12T19:00:00.000Z",
  "gatherBoxVersion": "0.0.0-dev",
  "skippedCount": 0,
  "file": {
    "path": "Sample_Author-Sample_Story.pdf",
    "index": 1
  },
  "chapters": [
    {
      "chapterNumber": 1,
      "label": "Chapter 1",
      "url": "https://example.invalid/fanfiction/s/42/1/"
    },
    {
      "chapterNumber": 2,
      "label": "Chapter 2",
      "url": "https://example.invalid/fanfiction/s/42/2/"
    }
  ]
}
```

## Field mapping from Gather Box payloads

Today’s collector types in `apps/gather-box/src/shared/types.ts` map to sidecar fields as
follows. This table guides the future writer implementation; nothing writes sidecars yet.

| Collector field | Sidecar field | Notes |
| --- | --- | --- |
| `site` | `site` | Same `SiteKey` string. |
| `pageUrl` | `sourceUrl` | Renamed for ingest clarity. |
| `galleryId` / `storyId` | `sourceId` | Unified name; galleries may omit when null. |
| `title` | `title` | Already sanitized for folders where applicable. |
| `author` | `creator` | Story payloads only. |
| `summary` | `summary` | Story payloads only. |
| `images[].fileName` | `files[].path` | Basename only. |
| `images[].originalUrl` | `files[].originalUrl` | Strip credentials before writing. |
| `images[].pageNumber` | `files[].pageNumber` | |
| `fileName` (story) | `file.path` | From `buildStoryPdfFileName`. |
| `chapters` | `chapters` | Same shape. |
| `skippedCount` | `skippedCount` | |
| (runtime) | `downloadedAt` | Set at save time. |
| (runtime) | `gatherBoxVersion` | From extension manifest when available. |

Fields intentionally **not** copied: `thumbnailUrl`, `metadataLine`, `folderSegments`,
raw HTML, cookies, auth headers, and local absolute destination paths.

## Privacy and safety

Sidecars are meant to sync with the archive. Treat them as **shareable metadata**, not a
credential store.

**Include**

- Public or page-level source URLs
- Site keys and public post/work IDs
- Titles, authors, chapter labels
- CDN or attachment URLs that do not embed session tokens
- Download timestamps and extension version

**Exclude**

- Cookies, `Authorization` headers, or session tokens
- Per-user download credentials configured in Gather Box
- Raw page HTML or full DOM snapshots
- Local absolute filesystem paths (archive root, `Downloads`, temp dirs)
- Query parameters that carry secrets (`token`, `sig`, `auth`, etc.) — strip or omit
  `originalUrl` when sanitization is uncertain

When in doubt, omit `originalUrl` rather than persist a credentialed link.

## Consumer rules (Lockstep / Pane View)

Future ingest code should:

1. **Discover** — While scanning, treat `.latch-works.source.json` as metadata, not media.
   Skip it for thumbnail generation and comic page lists.
2. **Parse leniently** — Unknown top-level fields are ignored (forward compatibility).
   Missing optional fields must not fail ingest.
3. **Validate version** — Accept `schemaVersion` values the consumer understands. Reject or
   quarantine manifests with a higher major version than supported; log and continue the
   sync run.
4. **Match files** — Resolve each `path` relative to the sidecar’s parent folder. If a
   listed file is missing, record a warning but still ingest present files and metadata.
5. **Do not trust paths** — Logical archive paths come from the scan; sidecar `path` values
   are basenames only. Never use sidecar content as a filesystem traversal input.
6. **Idempotent upsert** — Re-syncing the same folder should update source metadata without
   duplicating library rows (keyed by logical path + `sourceId` when present).

Pane View may later expose source-aware search and collections (`source-post` type in the
architecture plan). That work is a separate ingest plan after Gather Box writes sidecars.

## Compatibility

| Change type | Policy |
| --- | --- |
| Add optional field | Minor — old consumers ignore; new consumers may require. |
| Add required field | Major — bump `schemaVersion`. |
| Rename field | Major — bump `schemaVersion` or support both names during transition. |
| New `outputKind` | Major — bump `schemaVersion` unless consumers treat unknown kinds as opaque. |
| New `site` key | Minor — use string site keys; unknown sites still store metadata. |

Archives without sidecars remain valid. Ingest falls back to path/filename heuristics as
today.

## Rollout plan

1. **Design (this document)** — Agree schema, privacy rules, and shared types.
2. **Gather Box writer** — Optional setting to write `.latch-works.source.json` after a
   successful collect (default off until reviewed).
3. **Lockstep reader** — Attach parsed metadata to sync plan / ingest API payloads.
4. **Pane View storage** — Persist `source`, `sourceUrl`, `sourceId` on library entries;
   optional collections for source-grouped browsing.
5. **Backfill** — Out of scope; existing archives keep filename-only metadata unless
   re-collected.

## Related code and docs

- Gather Box collector types: `apps/gather-box/src/shared/types.ts`
- Path sanitization: `apps/gather-box/src/shared/path.ts`
- Shared TypeScript anchors: `packages/media-domain/src/gather-box-sidecar.ts`
- Architecture context: [ARCHITECTURE.md](./ARCHITECTURE.md) § Applications
- User-facing sources: [Supported sources](/docs/supported-sources)
