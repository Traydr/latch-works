# Oriel RS, Phase 1: the foundations

This page holds Phase 1's results: the rules ported from `media-domain` and `media-format`, the
background runtime, the ffmpeg tools, the checks, and video through libmpv. The code every
later phase builds on is in place and tested, with 111 Rust tests passing, and libmpv now plays
every container and seeks every codec exactly, at the cost of slower opens and about 1.7 to 1.8
times AVPlayer's CPU.

Phase 1 was done on 2026-10-28, on branch `agent/063-0-spike`. All six of the plan's steps are
done, plus [the runbook](../../runbooks/oriel-rs.md), the
[`oriel-rs.yml` workflow](../../../.github/workflows/oriel-rs.yml) and the libmpv video path the
owner chose. The owner answered its two questions with decisions 7 and 8 (libmpv by default, and
an LGPL libmpv build).

## The six steps

| Step | What exists | Crate |
|---|---|---|
| 1. Paths | One root, `~/.latch-works/oriel-rs`, with `shell`, `view`, `tidy`, `sync`, `hash-cache` and `sandbox` under it. It refuses Electron Oriel's folders as the root, and tests fail if a folder leaves the root or a Tidy root leaves the sandbox. | `oriel-core-paths` |
| 2. Rules | All of `media-domain` and the policies of `media-format`, each pinned by vectors from its package's Vitest suite. | `oriel-core-domain`, `oriel-core-format` |
| 3. Background work | Jobs on GPUI's background executor, a tokio thread for HTTP, and one SQLite thread per catalog. | `oriel-runtime` |
| 4. Tools | The same pinned ffmpeg and ffprobe as Electron Oriel, and a port of `run-tool.ts`. | `oriel-tools` |
| 5. Conformance harness | Vectors in `apps/oriel-rs/conformance/` for `media-domain` (6 files), `media-format` (5) and the fingerprints, written by each package's Vitest suite and read by `cargo test`. | all |
| 6. The check | `pnpm oriel-rs:check` runs `cargo fmt --check`, clippy with `-D warnings` and `cargo test`. The workflow also runs the TypeScript suites, which fail when a vector is stale. | |

## The rules match the TypeScript

- Beyond the 19 accepted Han pairs there is no difference.
- Matching needed V8's `Math.log`, JavaScript's `toFixed` rounding and JavaScript's `trim` set,
  written in Rust (`core-domain/src/number.rs`, `core-format/src/still_policy.rs`).
- Paths are `&str`, so a Windows name that holds a lone surrogate is Phase 8's problem.

## Animation conversion needs Mediabunny's decisions, not ffmpeg's

The plan said animations would convert through "ffmpeg with the fallback's arguments". That is
not what Electron Oriel does. Mediabunny, its main path, and the ffmpeg fallback differ:

- on short GIF delays: ffmpeg makes a delay under 20 ms into 100 ms, and Mediabunny raises one
  under 10 ms to 10 ms;
- on odd sizes: ffmpeg crops to even, and Mediabunny pads;
- on the key-frame interval: none in ffmpeg's, every 2 s in Mediabunny's;
- on quality.

`core-format` exposes Mediabunny's decisions, so Phase 6 can hand them to ffmpeg.

## The runtime and the tools

- **Jobs** are GPUI entities. Their progress is merged, they finish once, a panic is a failure,
  and they cancel by token or when dropped.
- **HTTP** runs on a tokio thread whose tasks GPUI can await.
- **SQLite** has one thread per catalog, with Electron Oriel's pragmas (WAL, `synchronous`
  NORMAL, foreign keys) and `user_version` migrations. It waits 5 s on a locked catalog, where
  `node:sqlite` waits 0, since nothing else shares its files.
- **ffmpeg and ffprobe** come from the same URLs and SHA-256 hashes as Electron Oriel's
  (`cargo run -p oriel-tools --bin fetch-media-tools`), and a hash mismatch is refused. A test
  fails if the pins and `apps/oriel/media-tools.ts` differ. `ORIEL_RS_MEDIA_TOOLS` wins over the
  bundle and the development cache, and `PATH` is never searched.
- **The runner** ports `run-tool.ts`: a timeout, a kill on cancel, bounded stdout, and the end of
  stderr kept for messages.

## Video through libmpv

libmpv is now the default (decision 7). mpv decodes in hardware through VideoToolbox, and its
OpenGL renderer draws into an IOSurface. VideoToolbox then converts that surface on the GPU to the
BT.601 `420f` buffer GPUI's `surface()` takes. No pixel passes through the CPU, and the colour is
within 1 level of mpv's. AVPlayer stays only as the fallback where libmpv cannot load, or with
`ORIEL_RS_VIDEO=avplayer`. The capsule player's scrubber seeks fast while it is dragged and exactly
when it is let go.

| | libmpv (Phase 1) | AVPlayer (Phase 0) |
|---|---|---|
| Open to first frame | 85–97 ms | 61–65 ms |
| Exact seek | Every seek lands on its target, AV1 included (181–210 ms median) | 98 / 73 / 399 ms for H.264 / HEVC / AV1; AV1 lands on the keyframe before |
| MKV, WebM, FLV, AVI and ASF | Play | Refused |
| CPU | About 1.7–1.8 times AVPlayer's | |
| Four 1440p60 tiles, app CPU | 69–75 % | 41 % |

By codec, the medians from the run's `mpv_spike sweep` over the 100 fixture videos of each codec,
beside Phase 0's AVPlayer scorecard. The AVPlayer figures are medians of 3 rounds, so the two
sides were not measured the same way.

| Codec | Open, libmpv / AVPlayer | Exact seek, libmpv / AVPlayer | Fast seek, libmpv / AVPlayer |
|---|---:|---:|---:|
| H.264 | 97 / 65 ms | 181 / 98 ms | 43 / 57 ms |
| HEVC | 85 / 61 ms | 181 / 73 ms | 31 / 56 ms |
| AV1 | 85 / 62 ms | 210 / 399 ms (AVPlayer on the keyframe before) | 30 / 53 ms |

So libmpv opens later and seeks exactly more slowly in H.264 and HEVC, but its exact seeks are
right in every codec, and its fast seeks, which the scrubber uses while dragging, are no slower.

The libmpv Oriel RS loads today is IINA's, read in place from `/Applications/IINA.app`. It is a
GPL build and must never ship. An LGPL build (mpv with `-Dgpl=false`, FFmpeg without
`--enable-gpl`) loses nothing playback needs, and building it is the next step (decision 8).

## Run it again

- `cargo run --release -p oriel-media --example mpv_spike --
  <single|tiles|sweep|errors|verify|colour>` from `apps/oriel-rs`. `ORIEL_RS_MPV_RENDER=sw`
  measures the software path.
- The runbook, [docs/runbooks/oriel-rs.md](../../runbooks/oriel-rs.md), covers the
  prerequisites, the vectors and the video switches.
