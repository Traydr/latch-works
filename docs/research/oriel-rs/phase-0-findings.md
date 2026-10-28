# Oriel RS, Phase 0: what GPUI did that the plan did not expect

This page lists the eight things Phase 0 found that plan 063 did not foresee, each with what was
done about it. The four that mattered, an unbounded image cache, the wrong colour matrix for
video, AV1 seeks and a frame cap on inactive windows, all have a working fix in Oriel RS. Only the
colour matrix still needs a fix upstream in GPUI.

## The four that mattered

1. **GPUI's image cache is not bounded.** `img(path)` keeps every image in the app's asset cache
   for good, and inside `uniform_list` an `image_cache()` element is not in effect. Scrolling
   20,000 tiles reached 11.5 GB before the fix.
   - The fix: an 80-line LRU attached to each `img()`, with a UI test that fails if a thumbnail
     lands in the app's cache.
   - Closed viewers also kept their stills in GPUI's sprite atlas. They are released now.
2. **GPUI's surface shader always uses the BT.601 matrix**, and HD video is BT.709, so colours
   were up to 26 levels off in green. GPUI also panics on any pixel format but `420f`.
   - The fix: the player asks AVFoundation for BT.601 output (about 4 % CPU per 1440p60 stream),
     and it checks every frame's format. The libmpv path of Phase 1 has VideoToolbox convert to
     BT.601 `420f` in the same way.
   - The real fix is upstream: GPUI should read the buffer's colour tag.
3. **AV1 exact seeks show no picture until the next keyframe** with SVT-AV1's default encode,
   in AVFoundation. They work when the file is encoded with `pred-struct=1` or
   `hierarchical-levels=0`.
   - The fix: the owner moved video to libmpv (decision 4), which seeks AV1 exactly. See
     [Phase 1](phase-1.md).
4. **GPUI throttles an inactive window to 30 frames a second**, so video behind another window
   ran at 24 fps.
   - The fix: the window lifts the cap (`inactive_frame_interval: None`). Nothing asks for frames
     at rest, so this costs nothing while idle.

## The smaller ones

5. **GPUI Kit's theme parser has no `zinc`**, and it falls back to its defaults without a word for
   a colour it cannot parse. The theme uses hex, and a test checks that every colour parses.
6. **`RenderImage` is BGRA with straight alpha**, and ImageIO writes AVIF and HEIC but not WebP.
   Thumbnails therefore go through libwebp, the encoder sharp uses.
7. **HEIC decodes** through ImageIO, but View does not list `.heic`, because `media-domain` does
   not. Whether it should is an open question for the owner.
8. **Extending `frame-performance.ts` was real work.** It is done: the script has a fixture mode
   with `requestAnimationFrame` frame intervals, per-process memory and CPU, viewer steps and
   video.
