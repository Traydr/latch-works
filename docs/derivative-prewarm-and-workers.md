# Derivative Pre-Warm, PDF Covers, and Worker Strategy

Design spike comparing how Pane View can move beyond purely on-demand thumbnail and
poster generation. This document records current behavior, evaluates three
architecture options, assesses PDF cover feasibility, and recommends the smallest
next implementation plan.

**Prerequisites:** [Plan 002 — reclaim derivative jobs](../plans/002-reclaim-derivative-jobs.md)
(done) and [Plan 009 — stream derivative generation](../plans/009-stream-derivative-generation.md)
(queued) improve on-demand reliability and memory use. Any pre-warm or worker path
should reuse the same `thumbnails` state machine and object-key helpers rather than
forking generation logic.

## Current behavior and bottlenecks

### On-demand generation path

The thumbnail route (`GET /api/media/:mediaId/thumbnail?size=`) requires a Better
Auth session, snaps `size` to the delivery ladder (`160, 320, 480, 640, 960`), and
calls `ensureThumbnailDerivative` in
`apps/pane-view/src/server/media/derivative-service.ts`. When a `ready` row already
exists, the handler issues a `302` to a signed `/cdn/v1/{token}` URL. Ready
derivatives are served through Railway CDN with long cache headers on the token
route.

While a derivative is generating, the authorize route returns **`503`** with
**`Retry-After: 1`**. Clients poll until the row reaches `ready` or `failed`.

### State machine and duplicate-work avoidance

Concurrent requests coordinate through the `thumbnails` table:

`pending` → `processing` → `ready` / `failed`

Plan 002 added deterministic claiming: expired `processing` leases (10 minutes,
see `derivative-lease.ts`) are reset to `pending` and reclaimed on the next
request. A concurrency limiter (`createConcurrencyLimiter(2)`) caps simultaneous
generations on a single Pane View instance.

### Generation by media type

| Media | Supported | Tool chain | Storage key |
| --- | --- | --- | --- |
| Image / GIF | Yes | `sharp` (rotate, resize, WebP) | `thumbnailObjectKey` → `thumbnails/sha256/...` |
| Video | Yes | `ffmpeg` poster frame + `sharp` WebP | `previewObjectKey` → `previews/video/sha256/...` |
| PDF | **No** | — | `previewObjectKey` exists for `mediaType: "pdf"` but `supportsDerivative` excludes PDF |

`generateDerivativeBytes` reads the full original object into memory (up to 512 MiB),
then runs sharp or ffmpeg. Plan 009 will stream large video originals to temp files
instead of buffering entirely in RAM.

### User-visible pain

1. **First gallery load** — every unseen item pays sharp/ffmpeg latency on the
   request path; video posters are especially expensive.
2. **503 polling** — tiles show loading/retry behavior until generation completes.
3. **PDF gap** — PDF library entries have no cover preview; the thumbnail route
   returns `404` for unsupported types (images/gif fall back to original on failure;
   video/PDF do not).
4. **Origin CPU** — ffmpeg and sharp run inside the web process with concurrency 2;
   large sync batches opened immediately in the browser can queue many concurrent
   `503` responses.

---

## Option comparison

### 1. Lockstep pre-warm

After Lockstep uploads and completes each object (`POST /api/sync/complete-object`),
the client requests `320` px derivatives for newly uploaded or updated image, GIF,
and video items — either by calling the authenticated thumbnail API or by invoking
a dedicated internal pre-warm endpoint.

| Dimension | Assessment |
| --- | --- |
| **User-visible improvement** | Gallery first paint for recently synced folders skips generation latency; `320` matches the default tile size and library snapshot ladder. |
| **Operational cost** | Extra origin CPU and egress during sync; sync duration grows. Lockstep must hold a valid API token and track which `mediaId` values to warm. Retries on `503` add client complexity. |
| **Failure / retry model** | Reuses existing `thumbnails` rows: `failed` rows retry on the next thumbnail request or a later pre-warm pass. No new queue semantics. |
| **Cancellation / duplicate work** | Same `pending` → `processing` claim as on-demand; duplicate pre-warm + browser requests collapse to one generation. Risk: pre-warm + gallery open during sync both hammer origin. |
| **Required code areas** | `packages/lockstep-core` push/complete flow; optional `apps/pane-view` internal route or documented use of `/api/media/:id/thumbnail?size=320`; no changes to object keys or CDN tokens. |
| **Testing strategy** | Lockstep integration test: after `complete-object`, assert `thumbnails` row reaches `ready` for size `320`. Pane View media tests for idempotent warm + `503` handling. |

**Pros:** Smallest infrastructure change; same object keys and URLs; headless Lockstep
fits existing sync model.

**Cons:** Shifts cost to sync time; warms only requested sizes (typically `320`);
does not help PDFs until PDF rendering exists; can amplify ffmpeg load if every
video is pre-warmed.

### 2. Pane View background worker

A separate process (Railway worker service or in-process job loop) polls
`thumbnails` for `pending` rows (or a new `derivative_jobs` table) and runs
generation out of band from HTTP requests.

| Dimension | Assessment |
| --- | --- |
| **User-visible improvement** | Thumbnail route usually finds `ready` rows immediately; fewer `503` responses during browsing. |
| **Operational cost** | New deployable, health checks, scaling rules, and observability. Worker and web must share DB + S3 credentials. Lease/reclaim logic must be worker-safe (compare-and-set on `processing`). |
| **Failure / retry model** | Worker marks `failed` with error text; needs backoff/retry policy and dead-letter visibility. Plan 002 lease expiry still required for crashed workers. |
| **Cancellation / duplicate work** | Requires explicit job ownership (worker ID, lease extension) to avoid web + worker double generation. May need `SKIP LOCKED` polling or a dedicated queue. |
| **Required code areas** | New worker entrypoint under `apps/pane-view` or a sibling app; extract generation from `ensureThumbnailDerivative` into shared "process one job" function; metrics hooks; possibly Redis/DB queue. |
| **Testing strategy** | Unit tests for job claim/release; integration test with worker + DB; load test for ffmpeg concurrency independent of HTTP thread pool. |

**Pros:** Decouples browsing latency from CPU-heavy work; natural place for PDF
covers and multi-size backfill; scales ffmpeg independently.

**Cons:** Largest operational and code footprint; premature without origin CPU
metrics; duplicates much of the existing on-demand state machine unless carefully
factored.

### 3. Hybrid

Keep on-demand generation as the default, and add **targeted pre-warm triggers**:

- Lockstep optional `--prewarm-thumbnails` for the latest sync run only.
- Admin or CLI endpoint to pre-warm a folder path or `syncRunId` (all `ready`
  library entries under that scope, size `320`).
- No always-on worker.

| Dimension | Assessment |
| --- | --- |
| **User-visible improvement** | Recent syncs and operator-selected folders get fast first paint; cold archives behave as today. |
| **Operational cost** | Lower than a 24/7 worker; higher than pure on-demand when pre-warm is enabled. Requires UX/docs for when to trigger. |
| **Failure / retry model** | Same as Lockstep pre-warm; failed rows remain visible in `thumbnails.error` for inspection. |
| **Cancellation / duplicate work** | Same claim semantics; manual re-run is idempotent once `ready`. |
| **Required code areas** | Pane View admin route or script (`pnpm` CLI) listing library entries by path/sync run and calling `ensureThumbnailDerivative`; optional Lockstep flag; audit logging. |
| **Testing strategy** | Scope-filter tests (only entries in folder); authz tests on admin route; regression that on-demand still works when pre-warm is off. |

**Pros:** defers worker investment; gives operators control; pairs well with PDF
on-demand (covers generated when first requested, then pre-warm backfills folders).

**Cons:** Does not fully solve "open entire archive" cold start; manual triggers are
easy to forget.

---

## PDF cover feasibility

### Fit with existing models

PDF covers should follow the same pattern as video posters:

1. **Object key** — `previewObjectKey({ mediaType: "pdf", sha256, size })` →
   `previews/pdf/sha256/{shard}/{hash}-{size}.webp` (already implemented in
   `packages/media-storage/src/index.ts`).
2. **Status** — one row per `(mediaObjectId, size)` in `thumbnails` with the same
   `pending` / `processing` / `ready` / `failed` lifecycle.
3. **Delivery** — on `ready`, redirect through existing `redirectToCdnDelivery` and
   signed CDN tokens; no URL shape changes.
4. **Descriptor** — extend `buildDerivativeDescriptor` to return
   `purpose: "preview"` and `previewObjectKey` when `mediaType === "pdf"`.
5. **Support gate** — add `"pdf"` to `supportsDerivative`.

### Rendering approach

**Target output:** render **page 1** of the PDF to **WebP** at the snapped ladder
size (same sharp resize path as images after rasterization).

**Likely tool: `pdfjs-dist`** — already a Pane View dependency (`^6.0.227`) for
the browser `PdfViewer`, which loads originals via `/api/media/:id/original` and
renders page 1 to `<canvas>`. Server-side reuse is feasible but not drop-in:

| Constraint | Detail |
| --- | --- |
| **Runtime** | `pdfjs-dist` expects a DOM/canvas in the browser. Node generation needs a canvas implementation (`@napi-rs/canvas` or `canvas` package) or an alternate rasterizer. |
| **Worker** | Browser code sets `GlobalWorkerOptions.workerSrc` from `pdf.worker.min.mjs`. Node can disable the worker or use `pdfjs-dist/legacy/build/pdf.mjs` with appropriate flags. |
| **Bundling** | `vite.config.ts` already marks `pdfjs-dist` as server external — server PDF code should import explicitly and stay out of the client bundle. |
| **Memory** | Same 512 MiB cap as other types applies; large PDFs may need streaming (Plan 009 pattern) before render. |
| **Licensing** | Apache 2.0 (`pdfjs-dist`) — no additional license blocker for server rendering. |

**Alternatives** if pdf.js on Node proves fragile:

- **Ghostscript / poppler** CLI (`pdftoppm`) — battle-tested rasterization, adds
  system binary dependency (similar operational story to `ffmpeg-static`).
- **sharp** — does not read PDF directly; must rasterize first.

**Recommendation for implementation spike:** prototype pdf.js + `@napi-rs/canvas` in
`derivative-service` behind a `mediaType === "pdf"` branch; fall back to poppler only
if canvas rendering quality or performance is inadequate.

### PDF-specific failure modes

- Encrypted or password-protected PDFs → `failed` status with clear `error` text.
- Corrupt files → same as existing image/video handling.
- Very large page dimensions → sharp `resize` with `withoutEnlargement: true`
  keeps output bounded.

No production PDF rendering is implemented in this spike.

---

## Recommendation

### Next build plan: PDF cover previews (on-demand)

Implement PDF page-1 covers through the **existing on-demand derivative path** before
investing in Lockstep pre-warm or a background worker.

**Why this first**

1. **Functional gap** — PDF is the only common library type with zero preview support
   today; pre-warm and workers only accelerate types that already work.
2. **Minimal new infrastructure** — no queue, no Lockstep protocol changes, no extra
   Railway service; extends `derivative-service.ts` and tests.
3. **Reuses prerequisites** — Plan 002 reclaim semantics and Plan 009 streaming apply
   directly; same `thumbnails` table and CDN delivery ladder.
4. **Enables later pre-warm** — once PDF generation exists, Lockstep pre-warm can
   cover all visual types uniformly.

### In-scope files (implementation plan, not this spike)

| Area | Files |
| --- | --- |
| Generation | `apps/pane-view/src/server/media/derivative-service.ts` |
| Tests | `apps/pane-view/src/server/media/derivative-service.test.ts` |
| Dependencies | `apps/pane-view/package.json` (likely `@napi-rs/canvas` or poppler wrapper) |
| Docs | `docs/runbooks/pane-view-thumbnails.md` (PDF row in generation table) |

### What not to build yet

- Railway background worker or job queue table.
- Lockstep automatic pre-warm after `complete-object` (track as a follow-up once
  PDF covers and optional origin metrics exist).
- Multi-size backfill worker (only generate requested ladder sizes on demand).
- Replacing the on-demand thumbnail route or changing CDN token shape.

### Follow-up sequence

1. **PDF covers (on-demand)** — this recommendation.
2. **Lockstep pre-warm for `320`** — optional flag after sync for image/GIF/video/PDF;
   document `503` retry in Lockstep client.
3. **Hybrid admin pre-warm** — if operators need folder-level backfill without
   re-syncing.
4. **Background worker** — only if success metrics below justify dedicated compute.

### Success metrics

| Metric | How to measure | Target (initial) |
| --- | --- | --- |
| **First-gallery thumbnail miss rate** | Ratio of thumbnail requests that return `503` before `ready` within a session | Establish baseline; post PDF ship, measure PDF folder opens separately |
| **Origin CPU time per derivative** | Railway metrics or structured log duration in `ensureThumbnailDerivative` | Track p95 for video (ffmpeg) and PDF (new); compare after Plan 009 streaming |
| **PDF cover availability** | Share of PDF library entries with `thumbnails.status = ready` at `320` after first view | > 95% for non-encrypted PDFs |
| **`failed` derivative rate** | Count `thumbnails.status = failed` by `mediaType` | Alert if PDF failure rate exceeds image baseline |

Defer the background worker decision until origin CPU p95 during gallery browsing
exceeds comfortable headroom for two concurrent ffmpeg jobs on the web tier.

---

## Related documents

- [Pane View thumbnails runbook](./runbooks/pane-view-thumbnails.md)
- [End-to-end request flow](./end-to-end-request-flow.md)
- [Plan 002 — reclaim derivative jobs](../plans/002-reclaim-derivative-jobs.md)
- [Plan 009 — stream derivative generation](../plans/009-stream-derivative-generation.md)
