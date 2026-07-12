# Latch Works

Latch Works collects, syncs, derives, and serves a private personal media archive.

## Language

**Derivative**:
A generated media representation stored separately from the original, such as a video poster or PDF cover preview. Image gallery tiles no longer use Derivatives in production — Bunny serves resized Originals instead.
_Avoid_: Optimized image, transformed image

**Rendition**:
A visual representation of a Shutter Asset. A Rendition is either produced on demand from its Source Object or materialized as a stored Derivative. On-demand Renditions may use requested dimensions and quality within their Shutter Space policy.
_Avoid_: Unbounded image resize, media URL

**Image Optimization**:
An on-demand Image Rendition that resizes a Source Object within requested width and height while preserving its composition, then WebP-encodes it at the requested quality.
_Avoid_: General-purpose image manipulation, arbitrary transformation pipeline

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

**Shutter**:
Private media infrastructure shared by Latch Works and other private applications. It captures durable visual renditions of stored media for its consuming applications.
_Avoid_: Media optimizer, public media platform

**Shutter Space**:
An isolated application configuration in Shutter with its own media storage, access credentials, and delivery policy.
_Avoid_: Shared storage bucket, public tenant

**Shutter Asset**:
The authoritative Shutter record for a source object and its renditions. A consuming application may mirror the original storage reference for its own operation, but that mirror does not control rendition lifecycle.
_Avoid_: Media file, application-owned rendition record

**Source Object**:
An immutable original stored by a consuming application. Replacing it creates a new object or object version and a new Shutter Asset.
_Avoid_: Mutable media file, overwritten original

**Pane View**:
The web service that owns auth, library state, derivative queue state, and signed delivery URLs.
_Avoid_: Gallery app, web frontend
