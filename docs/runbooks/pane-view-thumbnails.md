# Pane View Thumbnails and CDN Delivery

Pane View owns the durable derivative queue (`thumbnails` rows) and signed delivery URLs. In `inline` mode Pane View can generate thumbnails and video posters itself; in `triggered` mode it enqueues pending rows and wakes the separate **media-optimizer** service to do CPU-heavy generation. Bytes are stored in the Railway bucket at content-addressed keys and served through **Railway CDN** via signed `/cdn/v1/:token` URLs.

## Request flow

1. Library snapshots embed `thumbnailUrl` / `previewUrl` when a ready derivative row exists.
2. Gallery tiles render embedded `/cdn/v1/...` URLs directly and do not call a per-tile resolver.
3. Visible/near-visible gallery items without ready URLs are resolved through a bounded batched server function. Pending derivatives stay as placeholders while Pane View wakes the optimizer.
4. `/api/media/.../thumbnail` and `/api/media/.../preview` remain session-gated compatibility routes. They snap `size` to the ladder (`160, 320, 480, 640, 960`) and return `503` while a derivative is pending.
5. On success, derivative API routes return `302` to `/cdn/v1/{token}` with `Cache-Control: private, no-store`.
6. The browser loads `/cdn/v1/{token}` without an `Authorization` header so Railway CDN can cache `image/webp` responses. CDN `Cache-Control` uses `public, max-age={MEDIA_DELIVERY_TTL_SECONDS}` so edge caching does not outlive the signed token.

Full originals remain on `/api/media/:id/original` → S3 presigned URL (~60s) for video range performance.

## Generation

| Media | Tool | Storage key |
| --- | --- | --- |
| Image / GIF | `sharp` | `thumbnails/sha256/.../{hash}-{size}.webp` |
| Video | `ffmpeg` poster + `sharp` | `previews/video/sha256/.../{hash}-{size}.webp` |

The derivative state machine is `pending` → `processing` → `ready` / `failed`. In triggered mode, Pane View creates or resets pending rows and the media optimizer leases rows with a processing token. Stale `processing` rows are reclaimable after the derivative lease window.

## Operations

See [railway-cdn-pane-view.md](./railway-cdn-pane-view.md) for CDN enablement and `x-cache` verification. See [media-optimizer.md](./media-optimizer.md) for optimizer deployment, status endpoints, and queue diagnostics.

## Future options

Evaluated in [derivative-prewarm-and-workers.md](../derivative-prewarm-and-workers.md)
(spike, 2026-06). Status:

| Option | Status | Notes |
| --- | --- | --- |
| PDF cover previews (`previewObjectKey`, page 1 → WebP) | **Recommended next** | On-demand path; closes unsupported PDF gap |
| Lockstep pre-warm for `320` after sync | Active for triggered mode | Same object keys, no URL changes |
| Background worker | Active as `apps/media-optimizer` | Pane View owns queue state; optimizer owns CPU-heavy generation |
