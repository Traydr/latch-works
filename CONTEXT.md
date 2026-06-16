# Latch Works

Latch Works collects, syncs, derives, and serves a private personal media archive.

## Language

**Derivative**:
A generated media representation stored separately from the original, such as a gallery thumbnail or video preview.
_Avoid_: Optimized image, transformed image

**Derivative Queue**:
The durable `thumbnails` table state machine used to schedule and track derivative generation.
_Avoid_: Thumbnail cache, optimizer queue

**Derivative Demand**:
A request signal recorded on a Derivative Queue row that determines claim priority, such as on-demand preview demand or post-sync prewarm demand.
_Avoid_: Batch priority, optimizer priority

**Media Optimizer**:
The service that claims derivative queue rows and performs CPU-heavy derivative generation.
_Avoid_: Image proxy, thumbnail server

**Pane View**:
The web service that owns auth, library state, derivative queue state, and signed delivery URLs.
_Avoid_: Gallery app, web frontend
