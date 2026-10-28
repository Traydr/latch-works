# Oriel RS, Phase 0: the measurements

This page holds Phase 0's numbers: the five STOP conditions, the scorecard's Phase 0 rows for both
apps, the Library table with 100,000 rows, four video tiles playing at once, and what makes the
comparison unfair. On the same Mac and fixture, Oriel RS is about 14 times smaller, starts 2.6
times faster, uses a third of the memory at rest and a sixth after scrolling, and steps the viewer
11 to 23 times faster, while Electron Oriel opens and seeks video faster.

Report date: 2026-10-28. Plan: [063](../../plans/063-oriel-rs.md), D1 settled as A (GPUI Kit on
Zed's GPUI) by the owner on 2026-10-28. Built on branch `agent/063-0-spike` from `4c76020b`.
Machine: M5 Pro (18 cores, 48 GB), macOS 27.0.1, built-in 120 Hz display. The video rows here are
AVPlayer's. Video now plays through libmpv, whose numbers are in [Phase 1](phase-1.md).

## Every STOP condition passed

Two pass with a difference, and the owner accepted both on 2026-10-28: the 19 Han pairs as
documented differences, and AV1 seeking by moving video to libmpv.

| STOP condition | Result |
|---|---|
| Video through `surface()` seeks with sound in sync | **Passes** for H.264 and HEVC: after every seek the picture is within 12 ms of AVPlayer's clock. **AV1 (what Shrink writes) seeks only to the keyframe before the target**: an AVFoundation limit with SVT-AV1's default encode, confirmed outside GPUI. |
| The gallery scrolls at least as well as Electron Oriel's | **Passes**: the same p50 and p95, a lower p99 and max, 0 long frames against 15. |
| ImageIO decodes the fixture's AVIFs | **Passes**: 20,000 of 20,000 stills decode (9,986 AVIF, 10,014 JPEG). |
| Some Rust image pipeline matches the fingerprints exactly | **Passes through libvips**: sharp's own libvips build, loaded at run time, matches bit for bit on the whole corpus. The pure-Rust `image` crates do not. |
| ICU4X matches the order vectors | **Differs on 19 of 39,621 name pairs**, all Han ideographs from different Unicode blocks. Electron Oriel orders those 19 exactly as Rust does. The difference is Node's ICU against Chromium's, not Rust against Electron. |

## The scorecard's Phase 0 rows

Medians of 3 rounds, alternating apps, on a quiet machine. Window content 1280 × 900 at scale 2
(4 columns), fixture `~/.latch-works/oriel-rs/sandbox/spike-fixture` (20,000 stills, 300 videos,
40 comics, 19 GB). Oriel RS is the plain release build. Electron Oriel 0.1.5 (Electron 44.7.2) is
built from `4c76020b` and driven by Playwright.

| Measure | Oriel RS | Electron Oriel |
|---|---:|---:|
| Size on disk | 18.5 MB binary; about 37 MB as an `.app` with libvips (estimate) | 502 MB `.app` |
| Cold start: launch to first thumbnails drawn | 360 ms | 936 ms |
| Warm start: launch to first thumbnails drawn | 254 ms | 567 ms (946 ms after a full scroll) |
| All 20,000 stills listed | about 0.13 s after View opens | 1.39 s after Recursive |
| Memory 60 s after opening (resident / footprint) | 148 / 141 MB, 1 process | 1,408 / 435 MB, 11 processes |
| Memory 60 s after scrolling the gallery | 339 / 244 MB | 2,371 / 1,474 MB |
| Gallery scroll at 5,000 px/s: p50 / p95 / p99 / max | 8.33 / 9.7 / 10.2 / 10.5 ms | 8.4 / 9.7 / 10.5 / 16.3 ms |
| Long frames (over 1.5 × p50) in the scroll | 0 of 17,742 | 15 of 17,624 |
| Viewer step, AVIF / JPEG (p50) | 5.5 / 5.8 ms | 127 / 66 ms |
| Viewer step every 100 ms, stills drawn | 20 of 20 for both formats | AVIF 8 of 20, JPEG 20 of 20 |
| Video open to first frame, H.264 / HEVC / AV1 | 65 / 61 / 62 ms | 32 / 21 / 33 ms |
| Exact seek to frame, H.264 / HEVC / AV1 | 98 / 73 / 399 ms (AV1 lands on the keyframe before) | 45 / 37 / 54 ms |
| Fast seek to frame | 57 / 56 / 53 ms | 46 / 22 / 43 ms |
| CPU at rest, settled | 0.41 % | 0.57 % |
| CPU in the 60 s after the scroll | 0.46 % | 442 % (thumbnail workers) |

## The Library table with 100,000 rows

Oriel RS only: GPUI Kit's data table with 100,000 synthetic Library rows, three runs. No catalog
is behind it yet.

| Measure | Result |
|---|---:|
| Sort, natural order by name (ICU4X), rows then frame | 175 / 181 ms |
| Sort by size, date or dimensions | 7–10 ms |
| Scroll top to bottom at 30,000 px/s: p50 / p95 / max | 8.33 / 8.40 / 9.4–13.1 ms, at most 1 long frame of 12,798 |
| Select a row to the frame showing it (200 rows) | 8.33 ms p50, 8.47 ms max |
| Memory after scrolling (resident / footprint) | 141 / 227 MB |

## Four video tiles at once

Four Duplicates-style tiles played at once through AVPlayer, one with sound:

| Tiles | Dropped frames | CPU, app + system decoder |
|---|---:|---:|
| 1080p30 | 0 | 28 % + 11.5 % |
| 1440p60 | 1 of 2,401 | 41 % + 23 % |

## What makes the comparison unfair

- **The gallery is a spike, not parity.** Oriel RS's View has no index database, no metadata probe
  and no video posters yet. Electron Oriel does all three, and its six thumbnail workers stay
  alive at rest.
- **Electron is never fully warm on 20,000 stills.** It keeps 5,000 thumbnails on disk, so a full
  scroll evicts the first screen. It also made 39,895 thumbnails for 20,000 stills on its first
  scroll, which looks like a double request (unconfirmed, and worth a look in Electron Oriel).
- **The viewer step compares designs more than toolkits.** Oriel RS decodes at 2,560 px and
  decodes the neighbours ahead. Electron Oriel decodes full size, up to 12 MP, with nothing ahead.
- **Electron runs under Playwright** on the stock Electron binary, since the packaged app blocks
  the debugger. Summed resident memory overcounts Electron's shared pages, so footprint is the
  fairer figure.
- **Frame times are frames produced, not frames presented**, in both apps. ProMotion could not be
  pinned, and both apps saw 120 Hz.
- **The exact-seek row measures a path Electron Oriel's seek bar does not use.** Its seek bar
  always uses `fastSeek`.

## Run the measurements again

Run these from `apps/oriel-rs` unless noted:

- `node scripts/fixture/make-fixture.ts [--profile smoke]` makes the fixture in the sandbox.
- View's spike: the environment variables at the top of `crates/mode-view/src/spike.rs`.
- The Library spike: `ORIEL_RS_SPIKE_LIBRARY=100000 ORIEL_RS_SPIKE_SCROLL=30000
  ORIEL_RS_SPIKE_LOG=<file> target/release/oriel-rs`, documented in
  `crates/mode-tidy/src/spike.rs`.
- Video: `cargo run --release -p oriel-media --example video_spike --
  <single|tiles|sweep|errors>`.
- Electron Oriel, from the repository root after `electron-forge package`:
  `FRAME_PERF_FIXTURE_ROOT=<fixture> pnpm --filter @latch-works/e2e exec tsx
  scripts/frame-performance.ts <label>`. Phase 0 added the fixture mode to that script:
  `requestAnimationFrame` frame intervals, per-process memory and CPU, viewer steps and video.

The raw logs were under `/tmp/oriel-rs-phase0/`, `/tmp/oriel-rs-gallery/` and
`/tmp/oriel-video-work/` on the machine that ran them, and they are not kept.
