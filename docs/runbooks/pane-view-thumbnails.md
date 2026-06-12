# Pane View Thumbnails and CDN Delivery

Pane View generates thumbnails and video posters **on demand** when an authorized client requests `/api/media/:mediaId/thumbnail?size=...`. Bytes are stored in the Railway bucket at content-addressed keys and served through **Railway CDN** via signed `/cdn/v1/:token` URLs.

## Request flow

1. Gallery or `<img>` uses `/api/media/:id/thumbnail?size=320` until a `ready` row exists, then switches to `/cdn/v1/...` from the library snapshot.
2. `/api/media/.../thumbnail` requires a Better Auth session, snaps `size` to the ladder (`160, 320, 480, 640, 960`), and ensures the derivative exists.
3. On success, the API returns `302` to `/cdn/v1/{token}` with `Cache-Control: private, no-store`.
4. The browser loads `/cdn/v1/{token}` without an `Authorization` header so Railway CDN can cache `image/webp` responses. CDN `Cache-Control` uses `public, max-age={MEDIA_DELIVERY_TTL_SECONDS}` so edge caching does not outlive the signed token.

Full originals remain on `/api/media/:id/original` → S3 presigned URL (~60s) for video range performance.

## Generation

| Media | Tool | Storage key |
| --- | --- | --- |
| Image / GIF | `sharp` | `thumbnails/sha256/.../{hash}-{size}.webp` |
| Video | `ffmpeg` poster + `sharp` | `previews/video/sha256/.../{hash}-{size}.webp` |

While a derivative is generating, the authorize route returns **`503`** with **`Retry-After: 1`**. Concurrent requests use the `thumbnails` table (`pending` → `processing` → `ready` / `failed`) to avoid duplicate work.

## Operations

See [railway-cdn-pane-view.md](./railway-cdn-pane-view.md) for CDN enablement and `x-cache` verification.

## Future options

Evaluated in [derivative-prewarm-and-workers.md](../derivative-prewarm-and-workers.md)
(spike, 2026-06). Status:

| Option | Status | Notes |
| --- | --- | --- |
| PDF cover previews (`previewObjectKey`, page 1 → WebP) | **Recommended next** | On-demand path; closes unsupported PDF gap |
| Lockstep pre-warm for `320` after sync | Pending | Follow PDF covers; same object keys, no URL changes |
| Background worker | Deferred | Revisit when origin CPU / `503` miss-rate metrics justify a queue |
