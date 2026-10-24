# Latch Works

Latch Works collects, syncs, derives, and serves a private personal media archive.

## Language

**Derivative**:
A generated media representation stored separately from the original, such as a Shutter video poster or PDF cover preview. Image gallery tiles use on-demand Shutter Renditions rather than stored Derivatives.
_Avoid_: Optimized image, transformed image

**Rendition**:
A visual representation of a Shutter Asset. A Rendition is either produced on demand from its Source Object or materialized as a stored Derivative. On-demand Renditions may use requested dimensions and quality within their Shutter Space policy.
_Avoid_: Unbounded image resize, media URL

**Image Optimization**:
An on-demand Image Rendition that resizes a Source Object within requested width and height while preserving its composition, then WebP-encodes it at the requested quality.
_Avoid_: General-purpose image manipulation, arbitrary transformation pipeline

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
The web service that owns auth, library state, Source Object storage, and authorization for signed Shutter Renditions and original URLs.
_Avoid_: Gallery app, web frontend

**Gather Box**:
The browser collector that turns supported source pages into files in the authoritative local archive.
Its visible control surface is the side panel; collection execution is independent of that panel's
lifetime.
_Avoid_: Download popup, background downloader

**Gather Source**:
A supported external site together with its eligible page URLs, download origins, collection
behavior, credential policy, and archive save behavior.
_Avoid_: Host permission entry, collector switch case

**Gather Run**:
One identified attempt to collect an exact source tab and materialize its Gather Output in the local
archive. A Gather Run has one owner and remains observable when the Gather Box side panel closes.
_Avoid_: Popup session, pending download flag

**Gather Output**:
The files materialized by a Gather Run. An output is either a batch of source files or one generated
story PDF.
_Avoid_: Download response, popup payload

**Glazier**:
The desktop workbench that audits and tidies the authoritative local archive: inventory, exact and
similar duplicates, sound, and conversion to the archive formats. Its changes are Glazier Plans.
_Avoid_: File manager, cleaner, optimizer

**Glazier Plan**:
A reviewed set of steps (hold, move, rename, convert, remove folder) that Glazier applies only on
request, re-reading each file first and recording every finished step in its journal for undo.
_Avoid_: Batch job, auto-fix

**Holding**:
Where removed files and replaced originals wait, always outside their root: Glazier's data folder
when it shares the root's volume, otherwise a `.glazier-holding` folder at the top of the root's
volume. Restoring moves a file back, and emptying sends it to the system Trash.
_Avoid_: Trash, recycle bin, quarantine

**Archive Format**:
What the archive stores: AVIF for stills (libavif quality 70, speed 6) and MP4 for everything that
moves, with tracks in H.264, HEVC or AV1 and AAC or MP3 copied as they are.
_Avoid_: Optimized format, web format
