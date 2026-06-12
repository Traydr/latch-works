# Plan 014: Design Gather Box Sidecar Manifests

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving to the next step. If any
> STOP condition occurs, stop and report instead of improvising. When done,
> update this plan's row in `plans/README.md` unless a reviewer says they own the
> index.
>
> **Drift check (run first)**:
> `git diff --stat 326110f..HEAD -- docs/ARCHITECTURE_PLAN.md apps/gather-box/src/shared/types.ts apps/gather-box/src/shared/path.ts apps/gather-box/src/shared/gather-controller.ts apps/showcase/src/content/docs/supported-sources.mdx packages/media-domain/src`
> If any in-scope file changed, compare the excerpts below with the live code
> before proceeding. A mismatch is a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `326110f`, 2026-06-12

## Why this matters

Gather Box already knows source-site metadata when it downloads galleries and
stories, but that context is lost once files are only filenames in a local
archive. The architecture docs already call out sidecar manifests as a likely
future change. A small, versioned sidecar format would let Lockstep and Pane View
eventually support source-aware grouping/search without scraping folder names
later.

## Current state

- `apps/gather-box/src/shared/types.ts` defines collector payload metadata.
- `apps/gather-box/src/shared/path.ts` normalizes folder and file names.
- `apps/gather-box/src/shared/gather-controller.ts` orchestrates downloads.
- Showcase docs list supported source sites and output shapes.
- The architecture plan explicitly mentions future sidecar manifests.

Relevant excerpts at `326110f`:

```ts
// apps/gather-box/src/shared/types.ts:12-22
export interface DownloadablePayload {
  ok: true;
  outputKind: "downloadable-files";
  site: SiteKey;
  title: string;
  pageUrl: string;
  galleryId: string | null;
  folderSegments: string[];
  skippedCount: number;
  images: GalleryImage[];
}
```

```ts
// apps/gather-box/src/shared/types.ts:26-40
export interface GeneratedStoryPayload {
  ok: true;
  outputKind: "generated-story-pdf";
  site: "fanfiction-net";
  title: string;
  author: string;
  pageUrl: string;
  storyId: string;
  folderSegments: string[];
  skippedCount: number;
  fileName: string;
  summary: string;
  metadataLine: string;
  chapters: StoryChapterReference[];
}
```

```ts
// apps/gather-box/src/shared/path.ts:34-45
export function getFolderSegments(payload: DownloadablePayload | GeneratedStoryPayload): string[] {
  if (Array.isArray(payload.folderSegments)) {
    return payload.folderSegments.map(sanitizePathSegment).filter(Boolean);
  }
  ...
}
```

```md
<!-- docs/ARCHITECTURE_PLAN.md:76-78 -->
Likely future change:

- After Latch Works exists, Gather Box should optionally write a small sidecar
  manifest per downloaded post/story.
```

Repo conventions to match:

- Shared domain concepts belong in `packages/media-domain` when reused by apps.
- Gather Box is a Chrome extension; do not add Node-only APIs to shared extension
  code.
- Do not store secrets, cookies, or private session tokens in sidecars.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Gather typecheck | `pnpm --filter @latch-works/gather-box typecheck` | exit 0, no TypeScript errors |
| Domain typecheck | `pnpm --filter @latch-works/media-domain typecheck` | exit 0, if shared schema/types are added |
| Docs search | `rg "sidecar|manifest|source" docs apps/showcase/src/content/docs apps/gather-box/src` | output includes the new design references |

## Scope

**In scope**:

- A new design doc under `docs/` describing the sidecar schema and rollout
- `docs/ARCHITECTURE_PLAN.md`, only to link to the new design
- Optional type-only schema in `packages/media-domain/src` if the design needs a
  concrete interface
- Optional Gather Box docs updates in `apps/showcase/src/content/docs`
- `plans/README.md`, status row only

**Out of scope**:

- Actually writing sidecar files from Gather Box.
- Ingesting sidecars through Lockstep.
- Adding database tables for source metadata.
- Backfilling existing archives.

## Git workflow

- Branch: `codex/014-design-gather-box-sidecars`
- Commit style: short imperative summary, for example
  `Design Gather Box sidecar manifests.`
- Do not push or open a PR unless the operator asks.

## Steps

### Step 1: Inventory payload fields and privacy constraints

Review the collector payload types and supported-source docs. List which fields
are safe and useful for a sidecar:

- source site key
- source URL
- source item ID when present
- title/author/creator
- downloaded file list with original URL if safe
- chapter/page metadata
- collection timestamp and Gather Box version if available

Explicitly exclude cookies, auth headers, local absolute paths, and raw page
HTML.

**Verify**:
`rg "interface DownloadablePayload|interface GeneratedStoryPayload|Supported sources" apps/gather-box/src apps/showcase/src/content/docs`
-> output reviewed.

### Step 2: Write a versioned schema design

Create a design doc, for example:

`docs/gather-box-sidecar-manifests.md`

The doc must specify:

- filename convention, such as `.latch-works.source.json`
- JSON schema shape with `schemaVersion`
- gallery and story examples
- how file entries map to downloaded filenames
- privacy constraints
- how future Lockstep/Pan View ingestion should treat unknown fields
- backward/forward compatibility rules

Keep examples synthetic and do not include real URLs from the user's archive.

**Verify**:
`rg "schemaVersion|.latch-works.source.json|privacy" docs/gather-box-sidecar-manifests.md`
-> all terms present.

### Step 3: Decide whether to add type-only definitions

If the design would benefit from compile-time anchors, add type-only exports in
`packages/media-domain/src`, routed through `src/index.ts`. Do not add runtime
validation unless the design explicitly requires it.

If you add types, include a tiny test that validates representative example
objects with TypeScript-level checks or lightweight runtime guards already used
in the package.

**Verify**:
`pnpm --filter @latch-works/media-domain typecheck` -> exit 0 if touched.

### Step 4: Link the design from existing docs

Update `docs/ARCHITECTURE_PLAN.md` to point to the new design instead of leaving
the idea as a one-line future note. Optionally add a short Showcase docs note
that sidecars are planned, not shipped.

**Verify**:
`rg "gather-box-sidecar|sidecar manifest" docs apps/showcase/src/content/docs`
-> output includes the new links.

## Test plan

- This is a design/spike plan. Typecheck only if type files are added.
- No extension behavior should change.
- Do not add download or filesystem tests in this plan.

## Done criteria

- [ ] A sidecar manifest design doc exists with schema, examples, privacy rules,
      and rollout notes.
- [ ] Architecture docs link to the design.
- [ ] Optional shared types compile if added.
- [ ] No production behavior writes or ingests sidecars yet.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

Stop and report if:

- The operator wants sidecar implementation immediately instead of a design.
- Existing docs reveal a different metadata strategy already chosen.
- The design would require storing sensitive source credentials.

## Maintenance notes

This plan intentionally stops before implementation. The next plan should be a
build plan for Gather Box writing sidecars, followed by a separate Lockstep/Pan
View ingestion plan after the format is reviewed.
