# Latch Works

Latch Works collects, syncs, derives, and serves a private personal media archive.

## Language

**Derivative**:
A generated media representation stored separately from the original, such as a gallery thumbnail or video preview.
_Avoid_: Optimized image, transformed image

**Derivative Queue**:
The durable `thumbnails` table state machine used to schedule and track derivative generation.
_Avoid_: Thumbnail cache, optimizer queue

**Media Optimizer**:
The service that claims derivative queue rows and performs CPU-heavy derivative generation.
_Avoid_: Image proxy, thumbnail server

**Pane View**:
The web service that owns auth, library state, derivative queue state, and signed delivery URLs.
_Avoid_: Gallery app, web frontend
