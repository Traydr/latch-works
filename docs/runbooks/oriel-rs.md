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

The bundle step builds the LGPL libmpv the first time, fetches the pinned libvips, libavif,
ffmpeg and ffprobe, makes a release build, and leaves `Oriel RS.app` there; double-clicking it in
Finder works too. The pnpm scripts only run `cargo run -p xtask -- <command>` in `apps/oriel-rs`,
so the same commands work without pnpm. What you will see:

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
| meson, ninja, pkgconf | `brew install meson ninja pkgconf`, to build the LGPL libmpv (below); nothing else from Homebrew is installed or linked (libavif's bottles are fetched by URL and relocated, below) |

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

## Settings files and check variables

The shell keeps Electron Oriel's window state in `shell/window-state.json` and the values Electron
keeps in localStorage (`oriel.theme`, `oriel.sidebar`, `oriel.mode`, Tidy's `oriel.tidy.view`)
in `shell/local-storage.json`. These variables set up a run for a check, since this Mac allows no
scripted input:

| Variable | Effect |
| --- | --- |
| `ORIEL_RS_DATA_DIR=<folder>` | The data root, as `--user-data-dir` is for Electron Oriel |
| `ORIEL_RS_OPEN=<folder>` | View opens the folder at start |
| `ORIEL_RS_SETTINGS=general` | Settings opens at that section (`general`, `view`, `tidy`, `sync`) |
| `ORIEL_RS_ACTIVITY=tidy=0.4,sync=working` | Fakes mode activity; a faked progress makes ⌘Q wait, so press it twice |
| `ORIEL_RS_SYNC_PLAN=1` | Sync plans the active profile at start |
| `ORIEL_RS_VIDEO=avplayer` | Video through AVPlayer instead of libmpv |
| `ORIEL_RS_WELCOME=1` | Shows the first-run welcome under `ORIEL_RS_DATA_DIR` (it shows once otherwise, until `shell/welcomed` exists) |
| `ORIEL_RS_TIDY_ROOT=<folder>` | Tidy opens on that root (it must be in the sandbox) |
| `ORIEL_RS_TIDY_PAGE=<page>` | Tidy opens on that page (`overview`, `library`, `duplicates`, …) |
| `ORIEL_RS_CHANGES_ONLY=<scenario>` | `core-tidy`'s changes test runs one differential scenario |
| `ORIEL_RS_CHANGES_OUT=<file>` | `core-tidy`'s changes test writes Rust's report there |
| `ORIEL_SPIKE_PANEL=volume\|speed` | `mpv_spike` opens the player's volume or speed panel, for screenshots |

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
pnpm --filter @latch-works/oriel-rs libmpv     # cargo run -p xtask -- libmpv
```

It is built from source because no prebuilt LGPL libmpv dylib exists: MPVKit's LGPL builds are
static archives, and IINA's and mpv's own builds are GPL.

- **What it builds.** mpv 0.41.0 (`-Dgpl=false`, libmpv only), FFmpeg 9.0.2 (no
  `--enable-gpl`, `--enable-nonfree` or `--enable-version3`; every demuxer, decoder and
  VideoToolbox, no encoders, muxers or network), libplacebo, dav1d (AV1 in software where
  VideoToolbox cannot), and libass with FreeType, FriBidi and HarfBuzz, which mpv requires. The
  pins, hashes, licences and flags are in `crates/xtask/src/libmpv/sources.rs`.
- **Where it goes.** `apps/oriel-rs/.libmpv/<id>/`, git-ignored, with `.libmpv/current` pointing
  at it: 13 dylibs, 26 MB, each named `@rpath/…` and finding the others through
  `@loader_path`, ad hoc signed, for macOS 13 and later. Beside them are `manifest.json`
  (versions, hashes, flags, toolchain, and what the libraries report: each FFmpeg library says
  "LGPL version 2.1 or later"), `SHA256SUMS` and `licenses/`. `--out <dir>` builds the set
  somewhere else, to compare two builds.
- **How long.** 82 s from nothing on an M5 Pro, about 50 MB of downloads included; 78 s with the
  downloads cached. It is resumable: rerun it after an interruption and it carries on from the
  step that did not finish. The work tree is `apps/oriel-rs/target/libmpv/` (sources, builds,
  logs; deleted on success unless `--keep-work`). It refuses a download whose SHA-256 differs
  from its pin, builds with only meson, ninja, pkgconf and the system on `PATH`, and checks with
  `otool` that nothing outside the set and the system is linked.
- **Reproducible.** The command replaced a Node script (2026-10-29). Since recipe revision 2
  (set `mpv-0.41.0-ffmpeg-9.0.2-lgpl-83e766fd1f`) two builds are byte for byte the same in all 13
  dylibs: the builds run with `GIT_CEILING_DIRECTORIES` at the work root, so libass and
  libplacebo no longer embed the checkout's `git describe`, and with `ZERO_AR_DATE=1`.

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

## Vendored libraries

libvips and libavif are not built here: they come prebuilt, each pinned by URL and SHA-256, and
are checked before anything unpacks them (the owner's decision of 2026-10-29). One command fetches
both, or the one named:

```sh
pnpm --filter @latch-works/oriel-rs vendor     # cargo run -p xtask -- vendor [libvips] [libavif]
```

Each lands in `apps/oriel-rs/.vendor/<name>/<id>/`, git-ignored, with `.vendor/<name>/current`
pointing at it, beside its licences, `manifest.json` (URLs, hashes, how each hash was checked
against its publisher, licences, every library's links and minimum macOS) and `SHA256SUMS`. 7 s
from nothing, 21 MB of downloads (kept in `apps/oriel-rs/target/vendor/downloads/`); a rerun
checks the hashes and does nothing. The pins are in `crates/xtask/src/vendor/pins.rs`.

| Set | What | Size | macOS | Licence |
| --- | --- | --- | --- | --- |
| `libvips` | sharp's own build, `@img/sharp-libvips-darwin-arm64` 1.3.4 from npm (libvips 8.18.7, the one sharp 0.35.5 installs), its `lib/` as the package has it: one dylib that needs only the system | 18.2 MB | 11.0 | LGPL-3.0-or-later; the package's README lists each library inside |
| `libavif` | libavif 1.4.2 with aom 3.15.2, libvmaf 3.2.1 (aom links it) and dav1d 1.5.4 (libavif links it for decoding): Homebrew's `arm64_sequoia` bottles from its registry, renamed `@rpath/…` with `@loader_path` as their rpath and signed ad hoc again; aom's PATENTS comes from its source release | 6.3 MB, 4 dylibs | 15.0 | BSD-2-Clause, BSD-2-Clause-Patent |

- libavif publishes only command-line tools for macOS, and no other trusted prebuilt library
  has aom without bringing its own C++ runtime (conda-forge's), so the set is Homebrew's.
  Homebrew builds aom for macOS 15 and later only, so the set needs macOS 15.
- The vendored libvips is byte for byte the one in `node_modules`. The app finds libvips in its
  bundle's `Contents/Frameworks`, else the file `ORIEL_RS_LIBVIPS` names, else the vendored set,
  else `node_modules` (`Vips::open_located` in `oriel-core-tidy`). The fingerprint tests still
  load `node_modules`' copy unless `ORIEL_RS_LIBVIPS` names another.
- `oriel-avif` loads libavif from the app bundle's `Contents/Frameworks`, else the file
  `ORIEL_RS_LIBAVIF` names, else `.vendor/libavif/current`. Its tests skip, saying so, until the
  set is vendored.

## Making the app

`pnpm --filter @latch-works/oriel-rs bundle` (`cargo run -p xtask -- bundle`) makes
`apps/oriel-rs/target/release/bundle/Oriel RS.app` with:

| Part | Where | Size |
| --- | --- | --- |
| The release binary (`cargo build --release -p oriel-rs`, in `CARGO_TARGET_DIR` if set) | `Contents/MacOS/oriel-rs` | 23 MB |
| The LGPL libmpv set, built first if it is not | `Contents/Frameworks/` | 26.1 MB, 13 dylibs |
| The vendored libvips, fetched first if it is not | `Contents/Frameworks/` | 18.1 MB |
| The vendored libavif, fetched first if it is not; libmpv's dav1d 1.5.4 serves it, under the same install name | `Contents/Frameworks/` | 5.5 MB, 3 dylibs |
| The pinned ffmpeg and ffprobe, fetched first if they are not (`oriel-tools`' own code) | `Contents/Resources/media-tools/` | 126 MB |
| Each set's licences and manifest | `Contents/Resources/licenses/<set>/` | |
| Electron Oriel's icon, `Info.plist` (`dev.traydr.latchworks.oriel-rs`) | `Contents/` | |

197 MB in all, against Electron Oriel's 503 MB. `LSMinimumSystemVersion` is the newest macOS any
part needs, so the libavif set makes the app's macOS 15 and later (Oriel RS's own floor is 13).
The command checks that every library in `Contents/Frameworks` links only the system and the
others there, signs the whole ad hoc (`codesign --force --deep -s -`), checks it with
`codesign --verify --deep --strict`, and loads libmpv, libvips and libavif from the finished
bundle. Ad hoc signing runs on the Mac that built it. `ORIEL_MACOS_SIGN_IDENTITY` names a
Developer ID identity instead, signed with the hardened runtime and a timestamp as for Electron
Oriel (not yet tried with a real identity); notarizing is a follow-up. 43 s with the libraries in
place and a clean release build on an M5 Pro. The app carries no data: it uses
`~/.latch-works/oriel-rs/` as a development build does.

## Measuring

Phase 0's measurements are scripted, so a run repeats exactly; this Mac allows no scripted input.
The environment variables are documented at the top of each spike:

- View (gallery, thumbnails, viewer): `crates/mode-view/src/spike.rs`.
- The Library table: `crates/mode-tidy/src/spike.rs`.
- Video through AVPlayer, which `video_spike` forces: `cargo run --release -p oriel-media --example
  video_spike -- <single|tiles|sweep|errors>`,
  and the same through libmpv with `--example mpv_spike` (also `verify` and `colour`).
- Electron Oriel on the same fixture: `FRAME_PERF_FIXTURE_ROOT=<fixture> pnpm --filter
  @latch-works/e2e exec tsx scripts/frame-performance.ts <label>`.

Reports carry numbers only: the owner's library is never screenshotted or uploaded.
