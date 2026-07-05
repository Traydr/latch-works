# Plan 021: Add PDF Cover Previews To Derivative Flow

> **Executor instructions**: Run the drift check first. Treat this as a feature
> with security/resource limits: corrupt, encrypted, and huge PDFs must fail
> safely. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 8f19cd4..HEAD -- packages/media-derivatives/src packages/media-storage/src apps/pane-view/src/server/media apps/pane-view/src/features/gallery/Poster.tsx apps/media-optimizer/src apps/pane-view/src/server/db/schema.ts`

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-add-github-actions-verification-baseline.md
- **Category**: direction
- **Planned at**: commit `8f19cd4`, 2026-07-05

## Why This Matters

PDF/story entries are a supported media type but render as generic placeholders
in the gallery. Since this plan was first written, image/GIF derivatives and
Bunny image delivery landed; PDF is now the next missing derivative media type,
not the first non-video derivative. Adding PDF cover previews closes a visible
media-type gap while staying aligned with the durable derivative queue
architecture.

## Current State

- `packages/media-derivatives/src/descriptor.ts:13-15` returns true for
  `video`, `image`, and `gif`, but still returns false for `pdf`.
- `descriptor.ts:25-45` builds video preview object keys with
  `previewObjectKey(...)` and image/GIF thumbnail keys with
  `thumbnailObjectKey(...)`.
- `packages/media-storage/src/index.ts:40-43` already supports
  `previewObjectKey({ mediaType: "pdf", ... })`, producing `previews/pdf/...`.
- `packages/media-derivatives/src/generate.ts:34-64` handles video via ffmpeg
  and all other currently-supported derivatives via sharp image resizing; there
  is no PDF renderer path yet.
- `apps/pane-view/src/server/media/derivative-service.ts:199-201` returns
  `unsupported` when a media type is neither derivative-supported nor inline
  image-thumbnail supported.
- `apps/pane-view/src/server/media/derivative-prewarm.ts:56-59` skips rows where
  `supportsDerivative(row.mediaType)` is false.
- `apps/pane-view/src/server/media/derivative-queue.ts:69-71` only claims rows
  whose media object type is `video`, `image`, or `gif`.
- `apps/pane-view/src/features/gallery/Poster.tsx:21-23` only thumbnails image,
  GIF, and video, so PDFs use placeholders.
- `apps/pane-view/src/server/db/schema.ts:18` includes `pdf` in `mediaTypeEnum`,
  and `schema.ts:194` has `pageCount`.
- `CONTEXT.md` defines a Derivative as a generated media representation stored
  separately; use that term, not “optimized image”.

## Commands You Will Need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Derivatives tests | `pnpm --filter @latch-works/media-derivatives test` | exit 0 |
| Pane View media tests | `pnpm --filter @latch-works/pane-view test -- derivative-service resolve-delivery-url gallery` | exit 0 |
| Optimizer tests | `pnpm --filter @latch-works/media-optimizer test` | exit 0 |
| Typecheck | `pnpm --filter @latch-works/media-derivatives typecheck && pnpm --filter @latch-works/pane-view typecheck && pnpm --filter @latch-works/media-optimizer typecheck` | exit 0 |

## Scope

**In scope**:
- `packages/media-derivatives/src/descriptor.ts`
- New PDF renderer module under `packages/media-derivatives/src/`
- `packages/media-derivatives/src/generate.ts`
- Pane View derivative service/resolution tests
- Pane View optimizer claim filtering and Media Optimizer tests for PDF jobs
- `apps/pane-view/src/features/gallery/Poster.tsx`
- Package manifests only if a new PDF rendering dependency is required

**Out of scope**:
- Full PDF text extraction/search.
- Offline/PWA caching.
- Gather Box sidecar metadata.
- New collection or favorites features.

## Git Workflow

- Branch: `advisor/021-pdf-cover-previews`
- Commit message: `Add PDF cover previews`

## Steps

### Step 1: Pick And Add A Server-Side PDF Renderer

Choose the smallest reliable Node-compatible renderer already compatible with
the repo's stack. `pdfjs-dist` is already a Pane View dependency, but the shared
`media-derivatives` package may need its own dependency and possibly a canvas
backend. If rendering requires a heavy native dependency that is unsafe for
Railway or Electron builds, STOP and report options before proceeding.

**Verify**: `pnpm --filter @latch-works/media-derivatives typecheck` -> exits 0 after adding dependency/import skeleton.

### Step 2: Extend Derivative Descriptors

Change `supportsDerivative` to return true for `video`, `image`, `gif`, and
`pdf`. For PDFs, `buildDerivativeDescriptor` should use
`previewObjectKey({ mediaType: "pdf", ... })` and `purpose: "preview"`. Keep
image/GIF thumbnail behavior and video preview behavior unchanged.

**Verify**: `pnpm --filter @latch-works/media-derivatives test -- descriptor` -> includes PDF descriptor tests.

### Step 3: Generate First-Page WebP Bytes Safely

Implement PDF cover generation in `media-derivatives`. Requirements:

- read original bytes through existing storage helpers
- enforce a max source byte limit at least as strict as `DEFAULT_MAX_SOURCE_BYTES`
- render only page 1
- output WebP bytes and width/height matching existing `generateDerivativeBytes`
  return shape
- fail clearly for encrypted, corrupt, zero-page, or unsupported PDFs

**Verify**: `pnpm --filter @latch-works/media-derivatives test` -> tests cover valid PDF fixture and failure fixtures.

### Step 4: Allow PDF Jobs Through The Optimizer Queue

`apps/media-optimizer/src/processor.ts:108-117` already passes the claimed
job's `mediaType` into `generateDerivativeBytes`; after PDF generation is added,
no optimizer media-type guard needs to be loosened unless tests expose one.
Update processor tests so a PDF job is generated, uploaded, and completed. Also
update Pane View's optimizer claim filter to include `pdf`.

**Verify**: `pnpm --filter @latch-works/media-optimizer test` -> processor tests pass with PDF job coverage.

### Step 5: Show PDF Covers In Pane View Gallery

Update `Poster.tsx` and gallery thumbnail request logic so PDFs are
thumbnail-capable when a ready PDF preview URL/token is available or can be
resolved. Ensure `resolveMediaDeliveryUrl` and library snapshot code request or
embed PDF preview derivatives the same way video previews are handled; do not
route PDFs through Bunny image delivery.

**Verify**: `pnpm --filter @latch-works/pane-view test -- derivative-service resolve-delivery-url gallery` -> exits 0.

## Test Plan

- `media-derivatives`: descriptor tests for PDF; generation tests for valid,
  corrupt/encrypted/oversized PDFs.
- `media-optimizer`: PDF job is processed, unsupported media still fails.
- Pane View: optimizer claim includes PDFs, derivative service returns
  pending/ready for PDFs, and `Poster` treats PDF as thumbnail-capable.

## Done Criteria

- [ ] PDFs are supported by derivative descriptors with preview object keys.
- [ ] PDF first-page cover generation outputs WebP bytes with dimensions.
- [ ] Corrupt/encrypted/oversized PDFs fail safely without crashing worker.
- [ ] Media Optimizer processes PDF derivative jobs.
- [ ] Pane View gallery can display ready PDF cover previews.
- [ ] Focused tests and typechecks exit 0.
- [ ] `plans/README.md` status row updated.

## STOP Conditions

- Chosen renderer cannot run in Node/Railway without heavy unapproved native
  dependencies.
- PDF rendering requires loading unbounded file sizes into memory.
- Existing storage key helpers do not support PDF preview keys as expected.

## Maintenance Notes

- PDF cover previews are Derivatives. Use the repo vocabulary from `CONTEXT.md`:
  Derivative, Derivative Queue, Media Optimizer, Delivery Token.
