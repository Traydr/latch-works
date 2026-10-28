# Oriel GPUI, Phase 0: the spike and the gate

Report date: 2026-10-28. Plan: [063](../plans/063-oriel-gpui.md), D1 settled as A (GPUI Kit on
Zed's GPUI) by the owner on 2026-10-28. Built on branch `agent/063-0-spike` from `4c76020b`.
Machine: M5 Pro (18 cores, 48 GB), macOS 27.0.1, built-in 120 Hz display.

## Verdict

Every STOP condition passes, two of them with a difference the owner should accept or reject:

| STOP condition | Result |
|---|---|
| Video through `surface()` seeks with sound in sync | **Passes** for H.264 and HEVC: after every seek the picture is within 12 ms of AVPlayer's clock. **AV1 (what Shrink writes) seeks only to the keyframe before the target**: an AVFoundation limit with SVT-AV1's default encode, confirmed outside GPUI. |
| The gallery scrolls at least as well as Electron Oriel's | **Passes**: the same p50 and p95, a lower p99 and max, 0 long frames against 15. |
| ImageIO decodes the fixture's AVIFs | **Passes**: 20,000 of 20,000 stills decode (9,986 AVIF, 10,014 JPEG). |
| Some Rust image pipeline matches the fingerprints exactly | **Passes through libvips**: sharp's own libvips build, loaded at run time, matches bit for bit on the whole corpus. The pure-Rust `image` crates do not. |
| ICU4X matches the order vectors | **Differs on 19 of 39,621 name pairs**, all Han ideographs from different Unicode blocks. Electron Oriel orders those 19 exactly as Rust does: the difference is Node's ICU against Chromium's, not Rust against Electron. |

On the scorecard's Phase 0 rows Oriel GPUI is about 14 times smaller, starts 2.6 times faster,
uses a third of the memory at rest and a sixth after scrolling, and steps the viewer 11 to 23 times
faster. Electron Oriel opens and seeks video faster.

## Scorecard, Phase 0 rows

Medians of 3 rounds, alternating apps, on a quiet machine. Window content 1280 × 900 at scale 2
(4 columns), fixture `~/.latch-works/oriel-gpui/sandbox/spike-fixture` (20,000 stills, 300 videos,
40 comics, 19 GB). Oriel GPUI is the plain release build; Electron Oriel 0.1.5 (Electron 44.7.2)
is built from `4c76020b` and driven by Playwright.

| Measure | Oriel GPUI | Electron Oriel |
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

Oriel GPUI only, GPUI Kit's data table with 100,000 synthetic Library rows (three runs):

| Measure | Result |
|---|---:|
| Sort, natural order by name (ICU4X), rows then frame | 175 / 181 ms |
| Sort by size, date or dimensions | 7–10 ms |
| Scroll top to bottom at 30,000 px/s: p50 / p95 / max | 8.33 / 8.40 / 9.4–13.1 ms, at most 1 long frame of 12,798 |
| Select a row to the frame showing it (200 rows) | 8.33 ms p50, 8.47 ms max |
| Memory after scrolling (resident / footprint) | 141 / 227 MB |

Four Duplicates-style video tiles playing at once (one with sound): 1080p30, 0 dropped frames,
28 % CPU for the app plus 11.5 % for the system's decoder; 1440p60, 1 dropped frame of 2,401,
41 % plus 23 %.

### What makes the comparison unfair

- **The gallery is a spike, not parity.** Oriel GPUI's View has no index database, no metadata
  probe and no video posters yet. Electron Oriel does all three, and its six thumbnail workers stay
  alive at rest.
- **Electron is never fully warm on 20,000 stills.** It keeps 5,000 thumbnails on disk, so a full
  scroll evicts the first screen. It also made 39,895 thumbnails for 20,000 stills on its first
  scroll, which looks like a double request (unconfirmed, and worth a look in Electron Oriel).
- **The viewer step compares designs more than toolkits.** Oriel GPUI decodes at 2,560 px and
  decodes the neighbours ahead. Electron Oriel decodes full size, up to 12 MP, with nothing ahead.
- **Electron runs under Playwright** on the stock Electron binary, since the packaged app blocks
  the debugger. Summed resident memory overcounts Electron's shared pages; footprint is the fairer
  figure.
- **Frame times are frames produced, not frames presented**, in both apps. ProMotion could not be
  pinned; both apps saw 120 Hz.
- **The exact-seek row measures a path Electron Oriel's seek bar does not use**: it always uses
  `fastSeek`.

## The ports

### Natural order (ICU4X)

`packages/media-domain/src/conformance.test.ts` computes the vectors from the real `sort.ts` and
checks them against `apps/oriel-gpui/conformance/media-domain/sort.json`; with
`ORIEL_GPUI_UPDATE_VECTORS=1` it rewrites them. `cargo test -p oriel-core-domain` checks Rust
against the same file. The corpus has 282 names in 200 equal classes, the name-then-path
tie-break, the FNV-1a hash over UTF-16 units, and every sort mode including random with 8 seeds.

- 39,602 of 39,621 pairs agree, including 64-bit and 254-digit runs, full-width and other digit
  scripts, NFC and NFD, Thai, Hangul jamo, emoji and ignorable characters.
- The 19 that differ are Han from different blocks (U+20000, U+3400, U+9FFF, U+F900 against
  common characters). Node's ICU orders all Han by radical and stroke ("unihan"); Chromium's and
  ICU4X's data order them by block, then code point ("implicithan"). Electron Oriel's main process
  and renderer both order the 19 as Rust does. The Rust test pins the 19 as known differences, so
  a new difference or a vanished one fails.
- Rust collates with the root order. Electron Oriel follows the system locale, which on this Mac
  is English and collates by root too. A Lithuanian-first Mac would differ.
- ICU4X's compiled data adds 1.24 MB to the binary.

### Fingerprints

`crates/core-tidy` ports the 64-bit perceptual hash, the detail print, the comparisons, animation
frame sampling and video frames. Spot variants depends on both prints. The corpus is 37 synthetic
files (1.75 MB) in `apps/oriel-gpui/conformance/fingerprints/`, rebuilt byte for byte by
`scripts/fingerprints/make-corpus.mts`.

| Pipeline | Stills exact (hash, pixels, detail print) |
|---|---|
| libvips 8.18.7, sharp's build, loaded at run time | 35 of 35, plus both animations, the video, 16 pairs and the probes |
| libvips 8.18.3 | 35 of 35 |
| libvips 8.17.3 | 34 of 35 (one CMYK detail print off by up to 3 levels; same hash) |
| `image` crates, written by hand | 13 of 33 hashes, 1 of 33 detail prints |

- Parity needs sharp's libvips release line. The binding is about 40 functions loaded from the
  dylib at run time, so nothing is needed at build time, and the LGPL is kept by dynamic loading.
- sharp runs its steps in an order the JavaScript chain hides (resize before EXIF rotation, flatten
  of 16-bit images onto 65,280), and V8's `Math.cos` differs from Rust's in 11 of the 256 table
  entries. The crate embeds V8's table.
- The `image` crates fail mostly on decoding: libvips decodes JPEG and WebP already shrunk.

### Scan and SHA-256

On the 19 GB fixture, medians of 3:

| | glazier-core | Rust, 4 threads | Rust, 16 threads |
|---|---:|---:|---:|
| Walk, 21,136 files | 70–93 ms | 23–36 ms | about the same |
| SHA-256 of every file, warm | 2.40 GB/s | 11.0 GB/s | 38 GB/s |
| SHA-256 of every file, pages dropped | 2.37 GB/s | 4.0 GB/s | 10.0 GB/s |

glazier-core's hash pass reads only files that share a size: 142 MB of 19 GB here, 0.11 s in
TypeScript and 0.04–0.07 s in Rust. Its whole engine scan takes 5.1–5.3 s, 85 % of it reading
media details through ffprobe, so that is where the Rust scan's time will go.

### AVIF encode

20 fixture JPEGs, the same decoded pixels to both encoders, at `ARCHIVE_AVIF_OPTIONS`:

| | Size | Encode, median per still | SSIM / PSNR |
|---|---:|---:|---:|
| Wasm (libavif 1.0.1, aom 3.7.0) | 5.62 MB | 1,787 ms | 0.9767 / 45.30 dB |
| Rust, libavif 1.4.2 with aom 3.15.2, 1 thread | +0.15 % | 442 ms | equal |
| Rust, 8 threads | +0.4 % | 142 ms | equal |

Every setting is expressible in libavif. The `libavif` crate needs cmake, which this Mac lacks, and
bundles an older libavif; the spike links Homebrew's libavif through a small C shim instead.

## Findings the plan did not foresee

1. **GPUI's image cache is not bounded.** `img(path)` keeps every image in the app's asset cache
   for good, and inside `uniform_list` an `image_cache()` element is not in effect. Scrolling 20,000
   tiles reached 11.5 GB before the fix: an 80-line LRU attached to each `img()`, with a UI test
   that fails if a thumbnail lands in the app cache. Closed viewers also kept their stills in
   GPUI's sprite atlas; they are released now.
2. **GPUI's surface shader always uses the BT.601 matrix**, and HD video is BT.709: up to 26 levels
   off in green. The player asks AVFoundation for BT.601 output (about 4 % CPU per 1440p60 stream).
   GPUI also panics on any pixel format but `420f`, so the player checks every frame. The real fix
   is upstream: read the buffer's colour tag.
3. **AV1 exact seeks show no picture until the next keyframe** with SVT-AV1's default encode. They
   work when the file is encoded with `pred-struct=1` or `hierarchical-levels=0`.
4. **GPUI throttles an inactive window to 30 frames a second**, so video behind another window ran
   at 24 fps. The window now lifts the cap (`inactive_frame_interval: None`); nothing asks for
   frames at rest.
5. **GPUI Kit's theme parser has no `zinc`** and silently falls back to its defaults for a colour it
   cannot parse. The theme uses hex, and a test checks every colour parses.
6. **`RenderImage` is BGRA with straight alpha**, and ImageIO writes AVIF and HEIC but not WebP, so
   thumbnails go through libwebp, the encoder sharp uses.
7. **HEIC decodes** through ImageIO, but View does not list `.heic`, because `media-domain` does
   not.
8. **Extending `frame-performance.ts` was real work** (now done: a fixture mode with
   `requestAnimationFrame` frame intervals, per-process memory and CPU, viewer steps and video).

## Decisions for the owner

1. **Go or no-go** on Phase 1, on the numbers above.
2. **Han ordering.** Accept the 19 documented pairs, since Rust matches Electron Oriel? Or make the
   vectors from Chromium's ICU instead of Node's? Pane View's server and the Lockstep CLI, under
   Node, already disagree with Electron Oriel on these pairs.
3. **AV1 seeking.** Change Shrink's encoder settings (size cost not measured yet), accept
   keyframe-precision seeks for AV1, or play AV1 through libmpv.
4. **libvips in the app.** Fingerprints need sharp's libvips line (about 18 MB) loaded in-process,
   where sharp ran it in a utility process. Pin the exact version, as the test does now, or accept
   any 8.18.x?
5. **libavif.** cmake as a build prerequisite, or link a system or vendored libavif as the spike
   does.
6. **Small ones.** Should View list HEIC? Should Rust follow the system locale for natural order?

**The owner's answers (2026-10-28):** go; video moves to libmpv for mpv's full capabilities,
which also settles AV1 seeking; the Han pairs are accepted; carrying sharp's libvips (about
18 MB) is accepted. The libavif build and the small ones stay open for Phase 1. Plan 063 records
them under "Settled by the owner".

## Reproducing

From `apps/oriel-gpui` unless noted:

- `pnpm oriel-gpui:check` (repo root): `cargo fmt --check`, clippy with `-D warnings`, 53 tests.
- `node scripts/fixture/make-fixture.ts [--profile smoke]` makes the fixture in the sandbox.
- View's spike: environment variables at the top of `crates/mode-view/src/spike.rs`.
- The Library spike: `ORIEL_GPUI_SPIKE_LIBRARY=100000 ORIEL_GPUI_SPIKE_SCROLL=30000
  ORIEL_GPUI_SPIKE_LOG=<file> target/release/oriel-gpui`, documented in
  `crates/mode-tidy/src/spike.rs`.
- Video: `cargo run --release -p oriel-media --example video_spike -- <single|tiles|sweep|errors>`.
- Fingerprints: `cargo run -p oriel-core-tidy --example fingerprint_parity`.
- Scan and AVIF: `cargo build --release -p oriel-bench [--features avif]`, then `scan-bench` and
  `avif-bench`; the TypeScript side is `scripts/fixture/bench-glazier.mts`.
- Electron Oriel: `FRAME_PERF_FIXTURE_ROOT=<fixture> pnpm --filter @latch-works/e2e exec tsx
  scripts/frame-performance.ts <label>` (repo root), after `electron-forge package`.

Raw logs from these runs are under `/tmp/oriel-gpui-phase0/`, `/tmp/oriel-gpui-gallery/` and
`/tmp/oriel-video-work/` on the machine that ran them; they are not kept.
