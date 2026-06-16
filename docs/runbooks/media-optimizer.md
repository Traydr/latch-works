# Media Optimizer Service

Pane View owns the derivative queue (`thumbnails` rows, claim/complete/fail). The **media-optimizer** service (`apps/media-optimizer`) does CPU-heavy `sharp` / `ffmpeg` work and reports results back over authenticated internal HTTP routes.

## Railway deploy

1. Create a separate Railway service from `apps/media-optimizer` with **Serverless** enabled so Railpack installs Linux `sharp` and `ffmpeg-static` binaries.
2. Set service env:
   - `MEDIA_OPTIMIZER_TOKEN` — shared secret (min 16 chars), must match Pane View
   - `PANE_VIEW_INTERNAL_URL` — Pane View base URL reachable from the optimizer (private networking preferred)
   - S3 credentials (`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`)
3. Health check: `GET /health`
4. Processing wake: `POST /internal/optimizer/process` with `Authorization: Bearer $MEDIA_OPTIMIZER_TOKEN`

## Internal operations endpoints

All `/internal/optimizer/*` endpoints require `Authorization: Bearer $MEDIA_OPTIMIZER_TOKEN`.

### Media optimizer service

| Endpoint | Behavior |
| --- | --- |
| `POST /internal/optimizer/process` | Starts a single background drain run and returns `202 { status: "started", runId }`; returns `202 { status: "busy", currentRunId }` when a run is already active. |
| `GET /internal/optimizer/status` | Returns `inFlight`, `currentRunId`, and the last completed run counters. |

### Pane View service

| Endpoint | Behavior |
| --- | --- |
| `POST /internal/optimizer/claim` | Atomically leases pending or stale derivative rows. |
| `POST /internal/optimizer/complete` | Marks a leased row `ready`; returns `409` when the lease no longer matches. |
| `POST /internal/optimizer/fail` | Records a failed attempt and either reschedules with backoff or marks the row `failed`. |
| `POST /internal/optimizer/release` | Returns unprocessed leased rows to `pending`. |
| `GET /internal/optimizer/queue-status` | Read-only queue diagnostics: counts by status, stale processing rows, due pending rows, and oldest pending timestamp. |

## Pane View production settings

Set these explicitly before enabling triggered mode:

```env
DERIVATIVE_PROCESSING_MODE=triggered
MEDIA_OPTIMIZER_URL=https://your-optimizer.up.railway.app
MEDIA_OPTIMIZER_TOKEN=...
```

Do not rely on inferring `triggered` from `MEDIA_OPTIMIZER_URL` alone in production — if the optimizer is down or mis-tokened, derivatives stay `pending` and Pane View does not fall back to inline generation.

Run `pnpm db:migrate` after deploy (migration `0006_optimizer_scheduling.sql`). With the lean Pane View build, **min-instances=1** is reasonable on the web service.

## Security

Internal routes (`/internal/optimizer/claim`, `/complete`, `/fail`, `/release`) are protected by `MEDIA_OPTIMIZER_TOKEN` bearer auth with timing-safe verification. Treat network isolation as mandatory in production: use Railway private networking or an equivalent so these paths are not reachable from the public internet.

## Gallery snapshot URLs

Ready gallery thumbnails are embedded in the library snapshot as signed CDN URLs at fetch time. They expire after `MEDIA_DELIVERY_TTL_SECONDS` (default 24h). Long-lived tabs need a navigation or library refetch to refresh signatures; this replaces the old `/api/media/...` redirect path that minted a fresh signature on every image load.

When a visible gallery window contains media without ready `thumbnailUrl` values, the browser sends a bounded batched resolve request for the visible/near-visible items. Missing derivatives stay as placeholders until the optimizer produces ready rows; every tile should not run its own retry loop.

## Logs

The optimizer emits single-line JSON events:

- `optimizer.process_requested`
- `optimizer.claim_start`
- `optimizer.claim_complete`
- `optimizer.job_start`
- `optimizer.job_complete`
- `optimizer.job_failed`
- `optimizer.job_stale_lease`
- `optimizer.jobs_released`
- `optimizer.batch_complete`
- `optimizer.pane_view_request_failed`

Pane View emits corresponding wake and queue events:

- `optimizer.wake_requested`
- `optimizer.wake_result`
- `optimizer.wake_failed`
- `optimizer.wake_skipped`
- `optimizer.claim`
- `optimizer.complete`
- `optimizer.fail`
- `optimizer.release`
- `optimizer.auth_failed`
- `derivative.prewarm`

Successful `derivative.resolve` logs are sampled to avoid request spam. Pending and failed outcomes remain logged.

## Common failure checks

1. `GET $OPTIMIZER_URL/internal/optimizer/status` with the optimizer bearer token.
   - If `inFlight` is always false and `lastRun` is absent, Pane View may not be waking the optimizer.
   - If `lastRun.emptyClaims` is high while Pane View has pending rows, check `PANE_VIEW_INTERNAL_URL` and token auth.
2. `GET $PANE_VIEW_URL/internal/optimizer/queue-status` with the same bearer token.
   - `pending > 0` and `nextAttemptDue > 0` means work is schedulable now.
   - `processing > 0` with `staleProcessing > 0` means the next claim should reclaim old leases.
   - `failed > 0` means inspect recent `optimizer.job_failed` logs and `thumbnails.error`.
3. Check Pane View `optimizer.wake_result`.
   - `status: 401` means the services disagree on `MEDIA_OPTIMIZER_TOKEN`.
   - Network failures or timeouts point at `MEDIA_OPTIMIZER_URL` or private networking.

## Verification

```bash
pnpm --filter @latch-works/media-derivatives check
pnpm --filter @latch-works/media-optimizer check
pnpm --filter @latch-works/pane-view check
```

After a sync, confirm `derivative.prewarm` telemetry and compare `queue-status` before and after an optimizer run. Pending rows should either become ready or move through failed/backoff states with visible logs.
