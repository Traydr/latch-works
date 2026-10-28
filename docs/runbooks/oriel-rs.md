# Oriel RS Runbook

Oriel RS is Oriel ported to Rust on GPUI with GPUI Kit, as an experiment beside the Electron
app: [plan 063](../plans/063-oriel-rs.md). Its code is the Cargo workspace in `apps/oriel-rs`.
It keeps its own data in `~/.latch-works/oriel-rs/` and never touches Electron Oriel's folders.

## Try it

With the prerequisites below in place, from the repository root:

```sh
pnpm install                                   # once
pnpm --filter @latch-works/oriel-rs bundle     # about 3 minutes the first time, seconds after
open "apps/oriel-rs/target/release/bundle/Oriel RS.app"
```

The bundle step builds the LGPL libmpv the first time, fetches the pinned ffmpeg and ffprobe,
makes a release build, and leaves `Oriel RS.app` there; double-clicking it in Finder works too.
What you will see:

- **View** opens empty, with an Open button at the top right. Pick a folder and it shows the
  folder's photos and videos as a gallery. Double-click one to open the viewer, where the arrows
  step and Escape closes; videos play there through the bundled libmpv.
  `open --env ORIEL_RS_OPEN=<folder> "apps/oriel-rs/target/release/bundle/Oriel RS.app"` opens
  a folder at start instead. View never writes into the folder it shows: its thumbnails go to
  `~/.latch-works/oriel-rs/view/`.
- **Tidy** lists its pages in the sidebar, each a placeholder for now.
- **Sync** is a placeholder.

## Prerequisites

| | macOS (Apple silicon) |
| --- | --- |
| Rust | rustup; `apps/oriel-rs/rust-toolchain.toml` pins the toolchain, and rustup installs it on the first `cargo` command |
| Platform tools | Xcode, or its command-line tools (`xcode-select --install`) |
| Node and pnpm | Node 24 and pnpm 12 (`pnpm install` at the root), for the conformance vectors and for sharp's libvips, which the fingerprint tests load |
| ffmpeg | The app's own pinned ffmpeg and ffprobe, fetched once (below); Homebrew's `ffmpeg` only for the fixture script, which needs its encoders |
| meson, ninja, pkgconf | `brew install meson ninja pkgconf`, to build the LGPL libmpv (below); nothing else from Homebrew is used or linked |

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
instead, and the app falls back to AVPlayer by itself when no libmpv loads.
`ORIEL_RS_MPV_RENDER=gl` (the default) draws through OpenGL into an IOSurface; `sw` draws in
software.

Oriel RS builds its own LGPL libmpv (decision 8) from pinned sources, in one command:

```sh
pnpm --filter @latch-works/oriel-rs libmpv     # scripts/libmpv/build-libmpv.ts
```

- **What it builds.** mpv 0.41.0 (`-Dgpl=false`, libmpv only), FFmpeg 9.0.2 (no
  `--enable-gpl`, `--enable-nonfree` or `--enable-version3`; every demuxer, decoder and
  VideoToolbox, no encoders, muxers or network), libplacebo, dav1d (AV1 in software where
  VideoToolbox cannot), and libass with FreeType, FriBidi and HarfBuzz, which mpv requires. The
  pins, hashes, licences and flags are in `scripts/libmpv/sources.ts`.
- **Where it goes.** `apps/oriel-rs/.libmpv/<id>/`, git-ignored, with `.libmpv/current` pointing
  at it: 13 dylibs, 26 MB, each named `@rpath/…` and finding the others through
  `@loader_path`, ad hoc signed, for macOS 13 and later. Beside them are `manifest.json`
  (versions, hashes, flags, toolchain, and what the libraries report: each FFmpeg library says
  "LGPL version 2.1 or later"), `SHA256SUMS` and `licenses/`.
- **How long.** 82 s from nothing on an M5 Pro, about 50 MB of downloads included. It is
  resumable: rerun it after an interruption and it carries on from the step that did not
  finish. The work tree is `apps/oriel-rs/target/libmpv/` (sources, builds, logs; deleted on
  success unless `--keep-work`). It refuses a download whose SHA-256 differs from its pin,
  builds with only meson, ninja, pkgconf and the system on `PATH`, and checks with `otool` that
  nothing outside the set and the system is linked.

The app looks for libmpv in this order, first found wins. It logs the one it loaded at the
`log` crate's info level (the app installs no logger yet), and the spike's `single` mode prints
it:

1. `Contents/Frameworks/libmpv*.dylib` in the app bundle it runs from;
2. the file `ORIEL_RS_LIBMPV=<dylib>` names;
3. the development build, `apps/oriel-rs/.libmpv/current`;
4. IINA's libmpv (`/Applications/IINA.app`), read in place, and only when not running from a
   bundle.

The bundle's libmpv is the LGPL set. IINA's build is GPL: it is for development only, and a
bundled app never loads it, even with nothing else to load.

## Making the app

`pnpm --filter @latch-works/oriel-rs bundle` (`scripts/bundle/make-app.ts`) makes
`apps/oriel-rs/target/release/bundle/Oriel RS.app` with:

| Part | Where | Size |
| --- | --- | --- |
| The release binary (`cargo build --release -p oriel-rs`, in `CARGO_TARGET_DIR` if set) | `Contents/MacOS/oriel-rs` | 23 MB |
| The LGPL libmpv set, built first if it is not | `Contents/Frameworks/` | 25 MB |
| The pinned ffmpeg and ffprobe, fetched first if they are not | `Contents/Resources/media-tools/` | 128 MB |
| The set's licences and manifest | `Contents/Resources/licenses/libmpv/` | |
| Electron Oriel's icon, `Info.plist` (`dev.traydr.latchworks.oriel-rs`, macOS 13 and later) | `Contents/` | |

176 MB in all, against Electron Oriel's 503 MB. The whole is signed ad hoc
(`codesign --force --deep -s -`), so it runs on the Mac that built it; signing and notarizing
for other Macs is a follow-up. The app carries no data: it uses `~/.latch-works/oriel-rs/` as a
development build does.

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
