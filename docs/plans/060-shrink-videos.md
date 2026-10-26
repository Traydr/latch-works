# Plan 060: Shrink, re-encoding the video archive to AV1 in batches

> **Executor instructions**: Written 2026-10-26 with the owner's decisions, which must not be
> re-asked: AV1 rather than HEVC, SVT-AV1 at CRF 35, batches that can be stopped and resumed, and
> giving up AV1 playback on devices without an AV1 decoder (the owner's 2020 iPad Pro). The
> measurements below were taken on the owner's library and decide the defaults; re-measure before
> changing them.
>
> **Drift check (run first)**: `git diff --stat 3cd8e10..HEAD -- packages/glazier-core/src/optimize
> packages/glazier-core/src/media apps/oriel/media-tools.ts`.

## Status

- **Status**: IN REVIEW (2026-10-26)
- **Priority**: P2 (the owner asked for it)
- **Effort**: M
- **Risk**: MEDIUM. Every step re-encodes an original, which goes to holding; nothing is lost
  until holding is emptied. A new ffmpeg build ships inside the app.
- **Planned at**: commit `3cd8e10`, 2026-10-26

## Why

The owner added 705 videos (31.7 GB, 6.2 hours, mostly 60 fps phone-style H.264 at about 12 Mb/s
and HEVC at about 10 Mb/s) and the library grew to 78 GB of video. Tidy's only route to AV1 was the
Library's Re-encode, which runs Chromium's WebCodecs encoder: libaom in realtime mode, which needed
about twice SVT-AV1's bytes for the same picture.

## What was measured

Twenty-second clips from 14 videos across the library's buckets, scored with VMAF against the
source on this Mac (M5 Pro), then 10-second clips from four of them for side-by-side review.
Savings use Tidy's rule of keeping an original unless the result is at least 5% smaller.

| Setting | Saved, library (78 GB) | Saved, batch (31.7 GB) | Median size | Median VMAF |
| --- | --- | --- | --- | --- |
| WebCodecs AV1 "high" (Tidy before) | ~44 GB | ~22 GB | 35% | 92.2 |
| SVT-AV1 CRF 30 | ~46.5 GB | ~23.4 GB | 30% | 94.5 |
| **SVT-AV1 CRF 35 (chosen)** | **~55 GB** | **~26 GB** | 21% | 93.4 |
| SVT-AV1 CRF 40 | ~61 GB | ~28 GB | 15% | 91.1 |
| x265 at CRF 35's size | same | same | 21% | 90.8 |

At equal size SVT-AV1 scored 1.8 to 3.1 VMAF above x265 on every sample. Low-bitrate 720p H.264
(under about 1.5 Mb/s) gained nothing from any encoder.

## Decisions

- **Encoder.** Every AV1 encode, Shrink's and the Library's Re-encode alike, runs ffmpeg's
  SVT-AV1 at preset 6 when the ffmpeg has it, and WebCodecs only when it does not. The AV1 CRF
  ladder follows the Video quality setting: medium 40, high 35 (the default), very high 30. A
  10-bit source stays 10-bit and keeps its colour tags (checked with a 10-bit HLG clip).
- **ffmpeg.** `ffmpeg-static` ships ffmpeg 6.0 with SVT-AV1 1.4, built without Apple Silicon's
  SIMD: the same output as SVT-AV1 4.2, about 16 times slower (0.15× realtime). On Apple silicon
  the build fetches Martin Riedl's static ffmpeg and ffprobe 9.0.2 (linked from ffmpeg.org, GPLv3,
  signed), pinned by URL and SHA-256 in `apps/oriel/media-tools.ts`, and Tidy prefers them.
  Elsewhere Tidy keeps `ffmpeg-static`; its x64 SVT-AV1's speed was not checked. View still uses
  `ffmpeg-static`, which decodes AV1 for thumbnails.
- **Which videos.** Videos not already AV1, at 0.8 bits per pixel each second or more, outside the
  sets duplicate review still needs (Convert's holds), and not marked as having come out no smaller
  before (`files.shrink_not_smaller`, separate from Convert's mark). Expected size is
  `size × clamp(0.55 / bits-per-pixel-second, 0.2, 1)`, fitted to the measurements above; on the
  catalog it predicts 58 GB saved against the measured 55 (51–59).
- **Batches.** Most bytes saved first. A run takes 5 GB, 20 GB or every video's originals
  (`shrinkBatch` in the contract, shared by the button and the planner). Pause holds a run after
  the video in progress; Stop leaves finished videos done; the next run starts with what is left,
  because converted videos are AV1 and failed ones are marked.
- **Time estimates.** Each machine times its SVT-AV1 encodes into its own catalog
  (`encode_timings`); a size class with three encodes of 10 s or more estimates from their median,
  and the rest scale the M5 Pro's figures by how the machine compares. With none timed yet, the
  M5 Pro's figures stand, and Shrink says the time is a first guess.
- **Not part of Tidy up.** Shrink has its own view and an Overview row, never a Tidy up step.

## Devices

Safari, and every browser on iPhone and iPad, plays AV1 only on chips with an AV1 decoder (A17
Pro, M3 and later). As of October 2026 no Blink-based Chrome has shipped for iPadOS, even in the
EU, and WebKit has no software AV1 decoder, so the owner's 2020 iPad Pro (A12Z) cannot play the
results in Pane View. The owner accepted that. Chrome, Firefox and Edge on desktops decode AV1 in
software.

## Not done

- Pinned builds for Windows and Linux, and moving View to the new ffmpeg.
- HDR10 mastering metadata was not checked (HLG was).
- No per-video progress inside a long encode; the run counts videos.
