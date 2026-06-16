# Latch Works

Latch Works collects, syncs, derives, and serves a private personal media archive.

## Language

**Derivative**:
A generated media representation stored separately from the original, such as a video poster or PDF cover preview. Image gallery tiles no longer use Derivatives in production — Bunny serves resized Originals instead.
_Avoid_: Optimized image, transformed image

**Delivery Token**:
A time-limited HMAC credential embedded in a URL path that authorizes CDN access to a specific stored object. Purposes include `thumbnail`, `preview`, and `original`.
_Avoid_: Private id hash, signed URL

**Image Delivery**:
The Bunny Optimizer path that resizes and WebP-converts image Originals at the edge from a Delivery Token.
_Avoid_: Thumbnail CDN, image proxy

**Derivative Queue**:
The durable `thumbnails` table state machine used to schedule and track derivative generation.
_Avoid_: Thumbnail cache, optimizer queue

**Derivative Demand**:
A request signal recorded on a Derivative Queue row that determines claim priority, such as on-demand preview demand or post-sync prewarm demand.
_Avoid_: Batch priority, optimizer priority

**Media Optimizer**:
The video-only derivative worker that claims Derivative Queue rows and performs CPU-heavy poster generation.
_Avoid_: Image proxy, thumbnail server

**Pane View**:
The web service that owns auth, library state, derivative queue state, and signed delivery URLs.
_Avoid_: Gallery app, web frontend
