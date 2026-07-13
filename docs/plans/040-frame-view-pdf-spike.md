# Plan 040: Validate and specify Frame View PDF reading

> **Executor instructions**: This is a time-boxed direction spike, not authorization to advertise or
> ship an incomplete reader. Preserve Electron sandboxing and delete throwaway prototype code unless
> every retention gate passes. Run every gate and update the plan index.
>
> **Drift check (run first)**: `git diff --stat fd5693d..HEAD -- apps/frame-view packages/media-domain docs apps/showcase/src/content/docs/frame-view`

## Status

- **Priority**: P2
- **Effort**: M (spike only; implementation to be re-estimated)
- **Risk**: MED
- **Depends on**: Plan 033, Plan 034
- **Category**: product direction / architecture spike
- **Planned at**: commit `fd5693d`, 2026-07-13
- **Original direction**: 1

## Why this matters

Gather Box produces story PDFs, Pane View reads PDFs, and the Showcase currently claims Frame View
does too. Frame's actual catalog, IPC contracts, thumbnails, and modal support only image/video. A
bounded spike should determine the secure Electron delivery boundary, PDF.js packaging model, and
reader performance contract before this promise becomes a broad cross-process implementation.

## Current state

- `apps/frame-view/src/shared/contracts.ts` models only image/video media.
- Frame catalog discovery, thumbnailing, and `ViewerModal` branch on image/video and do not index or
  open PDF files.
- `apps/showcase/src/content/docs/frame-view/comics-and-stories.mdx:12-30` and the Frame landing page
  describe a dedicated reader that does not exist.
- Pane's `PdfViewer` supplies useful behavior evidence, but Plan 034 must first replace its eager
  all-pages rendering; do not copy that implementation before virtualization lands.
- Plan 033 moves Frame's path/media classification toward the shared media domain. Adding PDF before
  that work would deepen the duplicate model.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Frame tests | `pnpm --filter @latch-works/frame-view test` | all supported-platform tests pass |
| Frame check | `pnpm --filter @latch-works/frame-view check` | exit 0 |
| Frame make | `pnpm --filter @latch-works/frame-view make` | distributable build succeeds |
| Package smoke | `pnpm --filter @latch-works/frame-view package` | packaged app opens synthetic PDF on a supported desktop |

## Scope

**In scope**: a decision/design document; synthetic PDF fixture; a minimal vertical prototype for
discovery -> secure protocol -> PDF.js worker -> one virtualized page window; package-size and worker
resolution measurements; thumbnail/resume/accessibility design; follow-up implementation slices.

**Out of scope**: production release; annotations/editing/forms; OCR; encrypted-password UX; cloud
PDF fetching; changing Pane's reader; unrestricted `file://` access; exposing Node APIs to renderer;
indexing arbitrary files outside selected roots.

## Git workflow

- Branch: `codex/040-frame-view-pdf-spike`
- Commit message: `Specify Frame View PDF reading`

## Steps

### Step 1: Define the product and security contract

Create `docs/frame-view-pdf-reader-design.md` with explicit answers for supported PDFs, catalog
visibility, mixed image/PDF folders, open/close and keyboard behavior, resume state, corrupt and
password-protected files, maximum tested size/page count, accessibility, and offline-only behavior.

Model the data flow through the existing main/preload/renderer split. Prefer the constrained custom
media protocol over raw file URLs, validate all paths remain under selected roots, and expose no raw
filesystem or Node surface to the renderer.

**Verify**: threat-model tests are named for traversal, unselected-root access, malformed PDFs, and
protocol MIME/range behavior; design review has no unresolved trust-boundary decision.

### Step 2: Prove PDF.js in development and packaged Electron

Using only a repository-owned synthetic fixture, prototype loading one document through the chosen
protocol and rendering a page with `pdfjs-dist`. Prove the worker asset resolves in dev and packaged
builds under the existing bundler, CSP, sandbox, and context isolation. Record added unpacked and
compressed package size plus first-page latency on a named test machine.

Do not disable Electron security controls to make the worker run. Keep dependency versions aligned
with Pane unless the design records a concrete incompatibility.

**Verify**: dev and packaged smoke tests open the fixture offline; no console worker fallback, CSP
violation, network request, or direct filesystem access occurs.

### Step 3: Prove the bounded rendering model

Adapt the windowing contract established by Plan 034: stable page-height placeholders, visible-page
rendering with small overscan, cancellation of obsolete PDF.js render tasks, and a fixed upper bound
on live canvases. Exercise a synthetic long document and resize/rapid navigation behavior. Do not
copy Pane's old eager all-pages loop.

**Verify**: an automated harness observes bounded live canvases/render tasks as page count grows and
confirms navigation reaches first/last pages without blank or reordered pages.

### Step 4: Design catalog, thumbnail, and resume integration

After Plan 033, specify the shared-domain changes needed for PDF classification without weakening
image/video/comic semantics. Trace exact Frame files and migrations for:

- PDF discovery and media contracts;
- first-page thumbnail generation/cache invalidation;
- a dedicated modal/reader route and keyboard focus ownership;
- page count and last-read page persistence;
- errors, diagnostics, and settings copy.

Choose whether thumbnail rasterization belongs in the existing worker pool or a separate bounded PDF
worker based on measured memory/failure isolation. Do not store source-derived data beside the source.

**Verify**: the design contains a schema/IPC compatibility table, migration/rollback story, test
matrix, and measured recommendation for worker ownership.

### Step 5: Turn evidence into implementation slices

Update the design record with the prototype results, accepted/rejected alternatives, dependency and
license review, exact production file list, fixtures, rollout gates, and estimates. Split production
work into independently reviewable follow-up plans: domain/catalog, secure delivery, thumbnailing,
reader/resume, and docs/release.

Retain prototype code only if it meets normal source quality, test, dependency, and packaging gates;
otherwise keep measurements/design and remove it before merging. Plan 039 must continue to describe
Frame PDF as planned until the production done criteria are met.

**Verify**: another agent can execute the follow-up slices without rediscovering a security,
packaging, persistence, or rendering decision.

## Test plan

Use small, long, malformed, traversal-attempt, and password-protected synthetic fixtures that are
safe to commit. Cover MIME/range protocol responses, root authorization, worker loading, render-task
cancellation, bounded canvases, resize, keyboard/focus behavior, and resume compatibility. Smoke the
packaged app on at least one target OS; record other OS coverage as an explicit rollout gate.

## Done criteria

- [ ] A reviewed design record resolves product, security, packaging, data, and performance choices.
- [ ] Development and packaged Electron load a synthetic PDF without weakened security controls.
- [ ] The prototype demonstrates bounded rendering independent of page count.
- [ ] Package-size, latency, memory, and worker-resolution evidence is recorded.
- [ ] Production work is split into precise, estimated follow-up plans.
- [ ] Showcase still labels Frame PDF as planned until the production feature ships.

## STOP conditions

- PDF.js requires disabling sandbox, context isolation, CSP, or path authorization.
- The selected protocol can expose arbitrary local files or selected-root boundaries are ambiguous.
- The worker cannot resolve reliably in packaged builds on a supported platform.
- Rendering remains proportional to total page count after applying the Plan 034 model.
- A dependency has an unacceptable license, unresolved native packaging burden, or material supply-chain concern.

## Maintenance notes

Re-run worker-resolution and package-size smoke tests on Electron/bundler/PDF.js upgrades. Treat PDF
rendering as hostile-document processing: keep dependencies current, workers bounded, and the
renderer isolated from filesystem authority.
