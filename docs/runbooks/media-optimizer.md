# Media Optimizer Service

Pane View owns the derivative queue (`thumbnails` rows, claim/complete/fail). The **media-optimizer** service (`apps/media-optimizer`) does CPU-heavy `sharp` / `ffmpeg` work and reports results back over authenticated internal HTTP routes.

## Railway deploy

1. Create a separate Railway service from `apps/media-optimizer` with **Serverless** enabled so Railpack installs Linux `sharp` and `ffmpeg-static` binaries.
2. Set service env:
   - `MEDIA_OPTIMIZER_TOKEN` — shared secret (min 16 chars), must match Pane View
   - `PANE_VIEW_INTERNAL_URL` — Pane View base URL reachable from the optimizer (private networking preferred)
   - S3 credentials (`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`)
3. Health check: `GET /healthz`
4. Processing wake: `POST /internal/optimizer/process` with `Authorization: Bearer $MEDIA_OPTIMIZER_TOKEN`

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

## Verification

```bash
pnpm --filter @latch-works/media-derivatives check
pnpm --filter @latch-works/media-optimizer check
pnpm --filter @latch-works/pane-view check
```

After a sync, confirm `derivative.prewarm` telemetry and optimizer `/process` runs enqueue gallery `320` derivatives before first gallery view.
