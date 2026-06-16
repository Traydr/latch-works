# Bunny CDN Image Delivery

Production image gallery tiles use **Bunny Optimizer** to resize and WebP-convert **Original** bytes at the edge. Video posters still use the **Derivative Queue** and **Railway CDN**.

## Chain

```text
Browser (Unpic + Bunny provider)
  → Bunny CDN (?width=…&quality=…)
    → cdn-selector /lw/{deliveryToken} (302)
      → pane-view /cdn/v1/{deliveryToken}
        → S3 Original
```

Pane View mints HMAC **delivery tokens** with `purpose: "original"`. The client builds Bunny URLs from the token; Bunny fetches the source image through cdn-selector on cache miss.

## cdn-selector (`lw` provider)

Deploy to the shared cdn-selector instance:

| Env | Example |
| --- | --- |
| `LATCH_WORKS_ORIGIN` | `https://pane-view-production.up.railway.app` |

Request shape: `GET /lw/{url-encoded-token}` → `302` → `{LATCH_WORKS_ORIGIN}/cdn/v1/{token}`

## Bunny pull zone

1. Create a pull zone with origin = cdn-selector hostname (same host used for other providers).
2. Enable **Bunny Optimizer** and the Dynamic Images API.
3. Attach a custom hostname (e.g. `img.example.com`).
4. Set pane-view env:
   - `BUNNY_CDN_HOST=img.example.com`
   - `VITE_BUNNY_CDN_HOST=img.example.com`
   - `IMAGE_DELIVERY_MODE=bunny`
   - `VITE_IMAGE_DELIVERY_MODE=bunny`

## Verification

```bash
# Mint a token from a logged-in session (or use a snapshot-embedded token), then:
curl -sI "https://img.example.com/lw/${TOKEN}?width=320&quality=80"
```

On cache miss expect Bunny → cdn-selector `302` → pane-view `200` with original `content-type`. Repeat the request; Bunny should return a cached WebP (`content-type: image/webp`).

## Local dev

Default is **inline** image delivery (sharp derivatives, no Bunny). Set `VITE_IMAGE_DELIVERY_MODE=inline` explicitly when testing without Bunny credentials.

## Dual CDN summary

| Media | Delivery |
| --- | --- |
| Image / GIF | Bunny Optimizer from Original token |
| Video poster | Railway CDN `/cdn/v1/{token}` derivative |
| PDF cover (future) | Railway CDN derivative |

See [pane-view-thumbnails.md](./pane-view-thumbnails.md) for the full thumbnail model.
