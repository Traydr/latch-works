# Pane View Thumbnails and CDN Delivery

Pane View owns signed delivery URLs and the **Derivative Queue** for video posters (and future PDF covers). **Image** gallery tiles use Bunny Optimizer in production; local dev uses inline sharp derivatives.

## Image delivery (production)

1. Library snapshots embed `thumbnailDeliveryToken` for images when `IMAGE_DELIVERY_MODE=bunny`.
2. Gallery tiles render via `@unpic/react` with `cdn="bunny"`, building `https://{BUNNY_CDN_HOST}/lw/{token}?width=…`.
3. Bunny fetches the Original through cdn-selector → pane-view `/cdn/v1/{token}` on cache miss.
4. No derivative queue wait for images — tokens mint immediately.

See [bunny-image-delivery.md](./bunny-image-delivery.md) for Bunny zone and cdn-selector setup.

## Video / derivative delivery

1. Library snapshots embed `thumbnailUrl` / `previewUrl` when a ready derivative row exists.
2. Visible items without embedded URLs resolve through batched `resolveMediaDeliveryUrls`.
3. Pending video derivatives wake the **media-optimizer** worker (video-only) in triggered mode.
4. Ready derivatives redirect to Railway CDN `/cdn/v1/{token}`.

## API routes

| Route | Behavior |
| --- | --- |
| `GET /api/media/:id/thumbnail` | Images (bunny): `302` to Bunny URL. Video: ensure derivative → `/cdn/v1/{token}` or `503` pending. |
| `GET /api/media/:id/preview` | Video poster / future PDF cover |
| `GET /api/media/:id/original` | Session-gated S3 presign (~60s) |
| `GET /cdn/v1/:token` | HMAC token → stream Original or Derivative from S3 |

## Generation (derivatives only)

| Media | Tool | Storage key |
| --- | --- | --- |
| Video | `ffmpeg` poster + `sharp` | `previews/video/sha256/.../{hash}-{size}.webp` |
| Image / GIF (inline dev only) | `sharp` | `thumbnails/sha256/.../{hash}-{size}.webp` |

Derivative state machine: `pending` → `processing` → `ready` / `failed`. The media-optimizer claims **video** rows only.

## Operations

- Railway CDN: [railway-cdn-pane-view.md](./railway-cdn-pane-view.md)
- Bunny images: [bunny-image-delivery.md](./bunny-image-delivery.md)
- Derivative worker: [media-optimizer.md](./media-optimizer.md)

## Future

PDF cover previews remain the recommended next derivative type. See [derivative-prewarm-and-workers.md](../derivative-prewarm-and-workers.md).
