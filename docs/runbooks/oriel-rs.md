# Oriel RS Runbook

Oriel RS is Oriel ported to Rust on GPUI with GPUI Kit, as an experiment beside the Electron
app: [plan 063](../plans/063-oriel-rs.md). Its code is the Cargo workspace in `apps/oriel-rs`.
It keeps its own data in `~/.latch-works/oriel-rs/` and never touches Electron Oriel's folders.

## Prerequisites

| | macOS (Apple silicon) |
| --- | --- |
| Rust | rustup; `apps/oriel-rs/rust-toolchain.toml` pins the toolchain, and rustup installs it on the first `cargo` command |
| Platform tools | Xcode, or its command-line tools (`xcode-select --install`) |
| Node and pnpm | Node 24 and pnpm 12 (`pnpm install` at the root), for the conformance vectors and for sharp's libvips, which the fingerprint tests load |
| ffmpeg | The app's own pinned ffmpeg and ffprobe, fetched once (below); Homebrew's `ffmpeg` only for the fixture script, which needs its encoders |

Windows and Linux are not supported yet (Windows is Phase 8).

## Run it

Fetch the pinned ffmpeg and ffprobe once, the same builds and SHA-256 hashes as Electron Oriel's
(`apps/oriel/media-tools.ts`). They land in `apps/oriel-rs/.media-tools`, which Git ignores;
`ORIEL_RS_MEDIA_TOOLS=<folder>` points the app at others. The tool tests skip, saying so, until
they are there.

```sh
cd apps/oriel-rs && cargo run -p oriel-tools --bin fetch-media-tools
```

From the repository root:

```sh
pnpm --filter @latch-works/oriel-rs dev   # cargo run: a debug build of the app
pnpm oriel-rs:check                       # cargo fmt --check, clippy -D warnings, cargo test
```

`ORIEL_RS_DATA_DIR=<absolute folder>` moves the data root, as `--user-data-dir` does for
Electron Oriel; it refuses Electron Oriel's folders. View opens a folder through its Open button,
or at start with `ORIEL_RS_OPEN=<folder>`.

Measure release builds: `cargo build --release -p oriel-rs` in `apps/oriel-rs`.

## The sandbox

Tidy changes files only in a root under `~/.latch-works/oriel-rs/sandbox/` or the temp folder,
until the owner lifts the sandbox (plan 063, ground rules). Make test archives there:

```sh
node apps/oriel-rs/scripts/fixture/make-fixture.ts --profile smoke   # about 250 files, 200 MB
node apps/oriel-rs/scripts/fixture/make-fixture.ts                   # 21,135 files, 19 GB
```

The script is seeded and resumable, and refuses any output outside the sandbox or `/tmp`.

## Keeping the two implementations in step

Each rule Oriel RS ports from a TypeScript package is pinned by vectors in
`apps/oriel-rs/conformance/<package>/`. The package's Vitest suite checks that TypeScript still
produces them, and `cargo test` checks that Rust does. When a TypeScript rule changes on purpose,
rewrite the vectors and port the change:

```sh
ORIEL_RS_UPDATE_VECTORS=1 pnpm --filter @latch-works/media-domain test
ORIEL_RS_UPDATE_VECTORS=1 pnpm --filter @latch-works/media-format test
UPDATE_FINGERPRINT_VECTORS=1 pnpm --filter @latch-works/glazier-core exec vitest run \
  src/similarity/fingerprint-vectors.test.ts
```

Then `pnpm oriel-rs:check` shows what Rust must change. Known differences are listed in the
tests themselves (the 19 Han pairs in `crates/core-domain/tests/conformance.rs`).

Fingerprints match glazier-core's only through the libvips build sharp ships. The Rust tests load
it from `node_modules`; `ORIEL_RS_LIBVIPS=<dylib>` points them at another.

## Video through libmpv

Video plays through libmpv (plan 063, decisions 4 and 7), which plays MKV, WebM, AVI, FLV and
ASF as well as MP4, and seeks AV1 exactly. `ORIEL_RS_VIDEO=avplayer` plays through AVPlayer
instead, and the app falls back to AVPlayer by itself when no libmpv loads. Until Oriel RS builds
its own LGPL libmpv, it loads the libmpv inside IINA (`/Applications/IINA.app`), read-only;
`ORIEL_RS_LIBMPV=<dylib>` points it at another. IINA's build is GPL: use it to develop, never
ship it. `ORIEL_RS_MPV_RENDER=gl` (the default) draws
through OpenGL into an IOSurface; `sw` draws in software.

## Measuring

Phase 0's measurements are scripted, so a run repeats exactly; this Mac allows no scripted input.
The environment variables are documented at the top of each spike:

- View (gallery, thumbnails, viewer): `crates/mode-view/src/spike.rs`.
- The Library table: `crates/mode-tidy/src/spike.rs`.
- Video: `cargo run --release -p oriel-media --example video_spike -- <single|tiles|sweep|errors>`,
  and the same through libmpv with `--example mpv_spike` (also `verify` and `colour`).
- Electron Oriel on the same fixture: `FRAME_PERF_FIXTURE_ROOT=<fixture> pnpm --filter
  @latch-works/e2e exec tsx scripts/frame-performance.ts <label>`.

Reports carry numbers only: the owner's library is never screenshotted or uploaded.
