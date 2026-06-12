# Railway CDN for Pane View

Pane View serves private thumbnails through a cacheable delivery route (`/cdn/v1/:token`) in front of Railway object storage. Full originals still use short-lived S3 presigned redirects.

## Enable CDN

1. Open the **pane-view** service in Railway.
2. Go to **Settings → Edge**.
3. Turn on **Enable CDN Caching**.
4. Keep **HTML Caching** on **Auto** (default).
5. Set **Default TTL** to match or exceed `MEDIA_DELIVERY_TTL_SECONDS` (default `86400` / 1 day).
6. Leave **Purge Cache on Deploy** at **Purge HTML** unless delivery code changed.

Delivery responses send `Cache-Control: public, max-age={MEDIA_DELIVERY_TTL_SECONDS}` for derived images so CDN caching stays within the signed token lifetime.

## Verify caching

1. Sign in to Pane View and open a folder with thumbnails.
2. Open DevTools → Network.
3. Load a thumbnail URL under `/cdn/v1/...` twice.
4. On the second request, confirm response headers:
   - `x-cache: HIT`
   - `age` increasing between refreshes

Use `/.railway/cdn-trace` on the service domain to confirm traffic is routed through the CDN edge.

## Environment

| Variable | Purpose |
| --- | --- |
| `MEDIA_DELIVERY_SECRET` | HMAC secret for `/cdn/v1` tokens (min 32 chars) |
| `MEDIA_DELIVERY_TTL_SECONDS` | Token lifetime (default `86400`) |

Rotate `MEDIA_DELIVERY_SECRET` if a delivery URL leaks. Purge CDN cache after rotation if needed.

## Health

`GET /api/health` reports `ffmpegAvailable` for video poster generation.
