# Pane View Thumbnails and CDN Delivery

Pane View owns signed delivery URLs and the **Derivative Queue** for image, GIF, and video derivatives. Production uses a **hybrid** image path: ready pre-generated WebP derivatives are served from Railway CDN; Bunny Optimizer fills in while jobs are pending. Local dev uses inline sharp derivatives.

## Image delivery (production)

1. Library snapshots embed `thumbnailUrl` when a ready 720px derivative exists; otherwise `thumbnailDeliveryToken` for Bunny.
2. Gallery tiles prefer embedded CDN URLs; Bunny tiles render via `@unpic/react` with `cdn="bunny"`.
3. Sync prewarm enqueues 720px thumbnails and 1080px previews for images through media-optimizer.
4. Bunny fetches the Original through cdn-selector → pane-view `/cdn/v1/{token}` on cache miss.

See [bunny-image-delivery.md](./bunny-image-delivery.md) for Bunny zone and cdn-selector setup.

## Video / derivative delivery

1. Library snapshots embed `thumbnailUrl` / `previewUrl` when a ready derivative row exists.
2. Visible items without embedded URLs resolve through batched `resolveMediaDeliveryUrls`.
3. Pending derivatives wake the **media-optimizer** worker in triggered mode.
4. Ready derivatives redirect to Railway CDN `/cdn/v1/{token}`.

## API routes

| Route | Behavior |
| --- | --- |
| `GET /api/media/:id/thumbnail` | Images: ready derivative → `/cdn/v1/{token}`; else Bunny `302`. Video: ensure derivative → `/cdn/v1/{token}` or `503` pending. |
| `GET /api/media/:id/preview` | 1080px derivative when ready |
| `GET /api/media/:id/original` | Session-gated S3 presign (~60s) |
| `GET /cdn/v1/:token` | HMAC token → stream Original or Derivative from S3 |

## Generation (derivatives)

| Media | Tool | Storage key |
| --- | --- | --- |
| Video | `ffmpeg` poster + `sharp` | `previews/video/sha256/.../{hash}-{size}.webp` |
| Image / GIF | `sharp` | `thumbnails/sha256/.../{hash}-{size}.webp` |

Gallery default: **720** (`GALLERY_THUMBNAIL_SIZE`). Preview default: **1080** (`PREVIEW_DERIVATIVE_SIZE`).

Derivative state machine: `pending` → `processing` → `ready` / `failed`. The media-optimizer claims **image, GIF, and video** rows.

## Operations

- Railway CDN: [railway-cdn-pane-view.md](./railway-cdn-pane-view.md)
- Bunny images: [bunny-image-delivery.md](./bunny-image-delivery.md)
- Derivative worker: [media-optimizer.md](./media-optimizer.md)

## Future

PDF cover previews remain the recommended next derivative type. See [derivative-prewarm-and-workers.md](../derivative-prewarm-and-workers.md).
