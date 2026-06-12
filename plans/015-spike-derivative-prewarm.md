# Plan 015: Spike Derivative Pre-Warm, PDF Covers, And Worker Strategy

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving to the next step. If any
> STOP condition occurs, stop and report instead of improvising. When done,
> update this plan's row in `plans/README.md` unless a reviewer says they own the
> index.
>
> **Drift check (run first)**:
> `git diff --stat 326110f..HEAD -- docs/runbooks/pane-view-thumbnails.md docs/end-to-end-request-flow.md apps/pane-view/src/server/media packages/media-delivery/src packages/media-storage/src`
> If any in-scope file changed, compare the excerpts below with the live code
> before proceeding. A mismatch is a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/002-reclaim-derivative-jobs.md, plans/009-stream-derivative-generation.md
- **Category**: direction
- **Planned at**: commit `326110f`, 2026-06-12

## Why this matters

Pane View generates thumbnails and video posters on demand. That keeps sync
simple, but the first gallery request can pay the full sharp/ffmpeg cost and PDFs
have no cover previews. The thumbnail runbook already names three future options:
Lockstep pre-warm, PDF covers, and a background worker. This plan is a spike to
choose the next derivative architecture before building a queue or changing sync.

## Current state

- `apps/pane-view/src/server/media/derivative-service.ts` generates image/GIF
  thumbnails and video poster previews.
- `packages/media-storage/src/index.ts` defines `previewObjectKey`; PDFs already
  map to `previews/pdf/...` in key construction.
- `docs/runbooks/pane-view-thumbnails.md` documents on-demand generation and
  future options.
- `docs/end-to-end-request-flow.md` states thumbnail generation is on demand.

Relevant excerpts at `326110f`:

```md
<!-- docs/runbooks/pane-view-thumbnails.md:3 -->
Pane View generates thumbnails and video posters on demand when an authorized
client requests /api/media/:mediaId/thumbnail?size=...
```

```md
<!-- docs/runbooks/pane-view-thumbnails.md:27-31 -->
Future options

- Lockstep pre-warm for 320 after sync (same object keys, no URL changes).
- PDF cover previews via previewObjectKey for pdf media type.
- Background worker if on-origin ffmpeg load becomes too heavy.
```

```ts
// packages/media-storage/src/index.ts:40-43
export function previewObjectKey({ mediaType, sha256, size }: DerivedObjectKeyParts): string {
  const previewType = mediaType === "pdf" ? "pdf" : mediaType;
  return `previews/${previewType}/sha256/${shardPath(normalizedHash)}/${normalizedHash}-${size}.webp`;
}
```

Repo conventions to match:

- Use existing object key helpers and delivery-token ladder.
- Keep Lockstep core headless; do not put UI prompts in core.
- Avoid shipping large architecture changes without measurement or a design doc.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Media tests | `pnpm --filter @latch-works/pane-view test -- src/server/media` | exit 0, if prototype code is added |
| Pane typecheck | `pnpm --filter @latch-works/pane-view typecheck` | exit 0, if source is touched |
| Docs search | `rg "pre-warm|PDF cover|background worker|derivative" docs apps/pane-view/src/server/media` | output reflects the spike result |

## Scope

**In scope**:

- A new design/spike doc under `docs/`
- `docs/runbooks/pane-view-thumbnails.md`, to link to the spike result
- Optional tiny prototype tests or code comments only if needed to validate
  feasibility
- `plans/README.md`, status row only

**Out of scope**:

- Shipping a background worker.
- Changing Lockstep sync behavior.
- Adding database migrations.
- Full PDF rendering implementation.
- Replacing the on-demand derivative route.

## Git workflow

- Branch: `codex/015-spike-derivative-prewarm`
- Commit style: short imperative summary, for example
  `Spike derivative prewarm strategy.`
- Do not push or open a PR unless the operator asks.

## Steps

### Step 1: Document the current derivative bottlenecks

Create a spike doc, for example:

`docs/derivative-prewarm-and-workers.md`

Summarize current behavior:

- thumbnail route ensures derivatives on demand
- ready rows are served through signed CDN paths
- request path returns `503` while generating
- image/GIF use sharp
- video uses ffmpeg poster extraction
- PDF is currently unsupported by derivative generation

Reference plans 002 and 009 as prerequisites for reliable job state and lower
memory pressure.

**Verify**:
`rg "on demand|503|ffmpeg|PDF" docs/derivative-prewarm-and-workers.md`
-> all concepts present.

### Step 2: Compare three options

In the spike doc, compare:

1. **Lockstep pre-warm**: after upload/complete, request or enqueue 320px
   derivatives for uploaded/updated items.
2. **Pane View background worker**: a server-side queue processes pending
   derivatives out of band.
3. **Hybrid**: keep on-demand generation but add admin/manual pre-warm for
   selected folders or recent sync runs.

For each option, include:

- user-visible improvement
- operational cost
- failure/retry model
- cancellation/duplicate-work behavior
- required code areas
- testing strategy

**Verify**:
`rg "Lockstep pre-warm|background worker|Hybrid|failure" docs/derivative-prewarm-and-workers.md`
-> all terms present.

### Step 3: Evaluate PDF cover feasibility

Document how PDF covers should fit the existing key and thumbnail model:

- use `previewObjectKey` for `mediaType: "pdf"`
- render page 1 to WebP at the requested ladder size
- store status in `thumbnails`
- return through existing CDN delivery

Identify the likely rendering tool. Since Pane View already depends on
`pdfjs-dist`, start there, but document any Node-runtime constraints discovered.

Do not implement PDF rendering in this spike unless the operator explicitly asks
for implementation.

**Verify**:
`rg "previewObjectKey|pdfjs-dist|page 1|WebP" docs/derivative-prewarm-and-workers.md`
-> all terms present.

### Step 4: Recommend one next build plan

End the spike doc with a recommendation:

- the smallest next implementation plan
- its in-scope files
- what not to build yet
- success metrics, such as first-gallery thumbnail miss rate or origin CPU time

Update `docs/runbooks/pane-view-thumbnails.md` to link to the spike and mark the
future options as evaluated or pending.

**Verify**:
`rg "Recommendation|success metrics|derivative-prewarm-and-workers" docs`
-> output includes the recommendation and link.

## Test plan

- This is a design/spike plan. Text scans are the primary verification.
- Run Pane View media tests/typecheck only if prototype source is touched.
- Do not start local PostgreSQL, MinIO, or a dev server for this spike unless the
  operator asks for measurement.

## Done criteria

- [ ] A spike doc compares pre-warm, worker, and hybrid approaches.
- [ ] PDF cover feasibility is documented against existing object-key and
      thumbnail status models.
- [ ] The thumbnail runbook links to the spike.
- [ ] The doc recommends one next build plan with explicit scope and metrics.
- [ ] No production worker/pre-warm behavior is shipped.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

Stop and report if:

- The operator wants immediate implementation instead of a spike.
- Existing docs already choose one derivative architecture.
- PDF rendering requires licensing/runtime decisions outside the repo.
- Meaningful recommendation requires production metrics that are not available.

## Maintenance notes

Execute this only after plans 002 and 009. The recommendation should become a new
implementation plan rather than expanding this spike into a large mixed PR.
