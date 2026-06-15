# Triggered Media Optimizer Service

## Summary

Build a separate `apps/media-optimizer` service for bounded, explicitly triggered derivative generation. Pane View keeps auth, DB ownership, gallery routes, and CDN signing; the optimizer handles CPU-heavy `sharp`/`ffmpeg` work after Pane View or Lockstep enqueues jobs.

This addresses the current cold-start failure mode in two tracks: first reduce the browser/server-function request storm, then move derivative generation out of the Pane View process.

## Key Changes

- Add `packages/media-derivatives` for server-only derivative generation shared by Pane View local fallback and the optimizer: image/GIF thumbnails, video posters, WebP resize, object-key descriptor helpers, max-source-size checks.
- Add `apps/media-optimizer` as a normal Railway service, not a Railway Function. It exposes `POST /internal/optimizer/process`, authenticates with `MEDIA_OPTIMIZER_TOKEN`, processes up to `batchLimit` or `maxRuntimeMs`, then returns counts.
- Keep Pane View as the DB/API owner. Add internal Pane View routes for optimizer job claim/complete/fail, protected by the same shared token.
- Extend `thumbnails` with worker-safe scheduling fields: `processing_token`, `attempt_count`, `next_attempt_at`, and indexes for pending work. Claim jobs with lease-token ownership so crashed optimizer runs can be reclaimed.
- Add `DERIVATIVE_PROCESSING_MODE=inline|triggered`. Local/dev defaults to `inline`; production uses `triggered` when `MEDIA_OPTIMIZER_URL` is configured.
- Fix gallery load behavior: use ready CDN URLs from the library snapshot, and globally throttle unresolved thumbnail polling so hundreds of mounted tiles do not each run their own 12-attempt server-function loop.

## Implementation Steps

1. Instrument and tame the current path.
   Add structured logs around derivative requests, pending/ready/failed results, generation duration, and media type. Update the gallery image loader to prefer ready `thumbnailUrl` values and cap unresolved derivative polling globally with jittered backoff.

2. Extract generation.
   Move the pure generation logic out of `apps/pane-view/src/server/media/derivative-service.ts` into `packages/media-derivatives`. Leave Pane View DB reads/writes in Pane View.

3. Add queue ownership.
   Add the `thumbnails` migration fields, then replace “claim by status only” with token-owned claim/complete/fail helpers. Preserve current `/api/media/:id/thumbnail`, `/api/media/:id/preview`, and `/cdn/v1/:token` URL shapes.

4. Add the optimizer app.
   `apps/media-optimizer` calls Pane View internal claim APIs, generates derivatives with `packages/media-derivatives`, uploads WebP outputs to S3, and reports completion/failure. It should use low default concurrency, ideally `1`, with env-configurable batch/runtime limits.

5. Wire triggers.
   Pane View enqueues and wakes the optimizer when a requested derivative is missing, using a short timeout and treating wake failure as non-fatal. Lockstep gets an optional post-push prewarm trigger for 320px derivatives from the completed sync run.

6. Deploy.
   Deploy `apps/media-optimizer` as a separate Railway service with Serverless enabled. Use private networking if available, but keep token auth regardless. Do not use Railway Cron for the primary flow; it can be added later as a periodic drain/backfill.

## Test Plan

- Unit tests for derivative generation extraction: image resize, video poster streaming, oversized source rejection, missing source handling.
- Pane View tests for enqueue idempotency, lease-token claim/complete/fail, expired processing reclaim, retry backoff, and unchanged fallback behavior for failed image/GIF derivatives.
- Gallery tests proving ready snapshot URLs bypass server functions and unresolved thumbnails obey the global concurrency limit.
- Optimizer tests with mocked Pane View internal APIs and storage: auth required, batch limit honored, success marks ready, generation failure marks retry/failed.
- Verification commands: `pnpm --filter @latch-works/media-derivatives check`, `pnpm --filter @latch-works/media-optimizer check`, `pnpm --filter @latch-works/pane-view check`, then `pnpm check`.

## Assumptions

- Chosen operating model: triggered batches, not sync-only prewarm or always-on polling.
- Initial scope is image/GIF thumbnails and video posters. PDF covers can follow on the same pipeline.
- Pane View remains usable if the optimizer cold-boots or returns a first-request failure: thumbnails stay pending and retry later; Pane View does not generate heavy derivatives in `triggered` mode.
- Railway docs as of May 29, 2026 support this shape: Serverless services wake on inbound traffic but may cold-boot or return first-request `502`; Cron jobs should run short tasks and exit; Railway Functions are single-file Bun services with a 96KB file limit, so they are not a good fit for this monorepo `sharp`/`ffmpeg` worker.
  References: [Railway Serverless](https://docs.railway.com/deployments/serverless), [Railway Cron Jobs](https://docs.railway.com/cron-jobs), [Railway Functions](https://docs.railway.com/functions).
