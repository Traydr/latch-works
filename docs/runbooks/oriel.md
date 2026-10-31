# Oriel Runbook

Oriel views, tidies and syncs a local archive in one native window: Rust on GPUI with GPUI Kit,
version 1.0.0. It began as Electron Oriel's port ([plan 063](../plans/063-oriel-rs.md), where it
was called Oriel RS) and has replaced the Electron app, which is gone from the repository. Its
code is the Cargo workspace in `apps/oriel`. It keeps its data in `~/.latch-works/oriel/`
(`%USERPROFILE%\.latch-works\oriel` on Windows).

## Try it

With the prerequisites below in place, from the repository root:

```sh
pnpm install                                   # once
pnpm --filter @latch-works/oriel bundle     # about 3 minutes the first time, seconds after
open "apps/oriel/target/release/bundle/Oriel.app"
```

The bundle step builds the LGPL libmpv the first time, fetches the pinned libvips, libavif,
ffmpeg and ffprobe, makes a release build, and leaves `Oriel.app` there; double-clicking it in
Finder works too. The pnpm scripts only run `cargo run -p xtask -- <command>` in `apps/oriel`,
so the same commands work without pnpm. What you will see:

- **View** opens empty, with an Open button at the top right. Pick a folder and it shows the
  folder's photos and videos as a gallery. Double-click one to open the viewer, where the arrows
  step and Escape closes; videos play there through the bundled libmpv.
  `open --env ORIEL_OPEN=<folder> "apps/oriel/target/release/bundle/Oriel.app"` opens
  a folder at start instead. View never writes into the folder it shows: its thumbnails go to
  `~/.latch-works/oriel/view/`.
- **Tidy** analyses the folders you add and offers to tidy them: duplicates, conversions, junk and
  shrinking. Its changes move files out to Holding, where they stay until you empty it, and each
  has an Undo.
- **Sync** pushes a folder to a Pane View server and prunes what was deleted.
- On the first start, the welcome asks for an archive folder for View, and Tidy and Sync if
  wanted. It can be skipped.

To install it like any app, make the DMG ([Making the app](#making-the-app)).

## Prerequisites

| | macOS (Apple silicon) |
| --- | --- |
| Rust | rustup; `apps/oriel/rust-toolchain.toml` pins the toolchain, and rustup installs it on the first `cargo` command |
| Platform tools | Xcode, or its command-line tools (`xcode-select --install`) |
| Node and pnpm | Node 24 and pnpm 12 (`pnpm install` at the root), for the conformance vectors and for sharp's libvips, which the fingerprint tests load |
| ffmpeg | The app's own pinned ffmpeg and ffprobe, fetched once (below); Homebrew's `ffmpeg` only for the fixture script, which needs its encoders |
| meson, ninja, pkgconf | `brew install meson ninja pkgconf`, to build the LGPL libmpv (below); nothing else from Homebrew is installed or linked (libavif's bottles are fetched by URL and relocated, below) |

Windows builds from this workspace but has not run there yet: see [the Windows
runbook](oriel-windows.md). Linux is not supported.

## Run it

Fetch the pinned ffmpeg and ffprobe once, the builds Electron Oriel pinned, by URL and SHA-256
(`crates/tools/src/pins.rs`). They land in `apps/oriel/.media-tools`, which Git ignores;
`ORIEL_MEDIA_TOOLS=<folder>` points the app at others. The tool tests skip, saying so, until
they are there.

```sh
cd apps/oriel && cargo run -p oriel-tools --bin fetch-media-tools
```

From the repository root:

```sh
pnpm --filter @latch-works/oriel dev   # cargo run: a debug build of the app
pnpm oriel:check                       # cargo fmt --check, clippy -D warnings, cargo test
```

`ORIEL_DATA_DIR=<absolute folder>` moves the data root, as `--user-data-dir` did for
Electron Oriel. View opens a folder through its Open button,
or at start with `ORIEL_OPEN=<folder>`.

Measure release builds: `cargo build --release -p oriel` in `apps/oriel`.

## Settings files and check variables

The shell keeps Electron Oriel's window state in `shell/window-state.json`, in the same format and
in coordinates across every display as Electron keeps them, so the window reopens on the display
it was on. The values Electron keeps in localStorage (`oriel.theme`, `oriel.sidebar`, `oriel.mode`, Tidy's `oriel.tidy.view`)
in `shell/local-storage.json`. These variables set up a run for a check, since this Mac allows no
scripted input:

| Variable | Effect |
| --- | --- |
| `ORIEL_DATA_DIR=<folder>` | The data root, as `--user-data-dir` was for Electron Oriel |
| `ORIEL_OPEN=<folder>` | View opens the folder at start |
| `ORIEL_VIEW_SCROLL=<px>` | View scrolls its grid that far down once the folder lists |
| `ORIEL_SETTINGS=general` | Settings opens at that section (`general`, `view`, `tidy`, `sync`) |
| `ORIEL_ACTIVITY=tidy=0.4,sync=working` | Fakes mode activity; a faked progress makes ⌘Q wait, so press it twice |
| `ORIEL_ACTIVITY_PANEL=1` | Opens the activity panel at the bottom right whenever work runs |
| `ORIEL_SYNC_PLAN=1` | Sync plans the active profile at start |
| `ORIEL_VIDEO=avplayer` | Video through AVPlayer instead of libmpv |
| `ORIEL_ABOUT=1` | Opens the About dialog at start, to see the version and the licences a bundle lists |
| `ORIEL_WELCOME=1` | Shows the first-run welcome under `ORIEL_DATA_DIR` (it shows once otherwise, until `shell/welcomed` exists) |
| `ORIEL_TIDY_ROOT=<folder>` | Tidy opens on that root (in a sandboxed run, one inside the sandbox) |
| `ORIEL_TIDY_PAGE=<page>` | Tidy opens on that page (`overview`, `library`, `duplicates`, `duplicates:identical`, …) |
| `ORIEL_DUPLICATES_MATCHING=1` | Duplicates opens its Matching popover when the page first draws |
| `ORIEL_HISTORY_OPEN=1` | History opens its newest entry |
| `ORIEL_MOVE_OFFER=1` | Offers the move to Applications even in a run that would skip it |
| `ORIEL_APPLICATIONS_DIR=<folder>` | Where that move goes, read only when the offer is forced |
| `ORIEL_QUICK_LOOK=<file>` | Tidy shows the file in Quick Look once it is up |
| `ORIEL_TIDY_PICKER=1` | Tidy opens its folder picker (Add Folder…) once it is up |
| `ORIEL_TIDY_RUN=convert,cleanup` | Once the folder on screen is scanned, Tidy starts those pages' changes; the second queues behind the first. It changes files: point it only at a copy |
| `ORIEL_LOCATIONS_MENU=1` | Opens the sidebar's location switcher about 4 s after the window first draws |
| `ORIEL_CHANGES_ONLY=<scenario>` | `core-tidy`'s changes test runs one differential scenario |
| `ORIEL_CHANGES_OUT=<file>` | `core-tidy`'s changes test writes Rust's report there |
| `ORIEL_SPIKE_PANEL=volume\|speed` | `mpv_spike` opens the player's volume or speed panel, for screenshots |

View's Debug logging setting prints each thumbnail event to the terminal as a `[thumbnails] …`
line on stderr; Performance monitoring adds a Timings group to View's Diagnostics.

## The sandbox

Tidy takes any folder Electron Oriel's Tidy takes, and changes files in it, when the app runs on
the owner's own data in `~/.latch-works/oriel` (plan 063, decision 18). It keeps Electron's
refusals: a folder that is missing, a file, or one that holds or lies in another root. A root on
another volume holds its files on that volume, in `.latch-works/oriel/holding/` at its top,
as glazier-core holds in `.latch-works/glazier/holding/`.

A run with `ORIEL_DATA_DIR` set (every check, test and agent run) is sandboxed: Tidy takes
only a root under that data folder's `sandbox/` or the temp folder, refuses a Move to… outside
them, and holds every file in its own data folder. The folder picker, the welcome, Settings and
a refused hand-off say so; the owner's run shows none of it. Agents change only archives under
`/tmp` or a scratch data folder's `sandbox/`, and copy (`cp -c`) what they need there.

The synthetic fixtures live outside every data folder, in `~/.latch-works/oriel-fixtures/`:

```sh
node apps/oriel/scripts/fixture/make-fixture.ts --profile smoke   # spike-fixture-smoke: about 250 files, 200 MB
node apps/oriel/scripts/fixture/make-fixture.ts                   # spike-fixture: 21,135 files, 19 GB
```

The script is seeded and resumable, and refuses any output outside `~/.latch-works/oriel-fixtures`
or `/tmp`. View, Sync and the benches read a fixture where it is; for Tidy in a sandboxed run,
clone it into the run's `sandbox/`, or make that `sandbox` a link to the fixtures' folder, as
`xtask measure` does.

## What Tidy changes on disk

Tidy keeps Electron Oriel's Tidy rules (once the Glazier app's, plan 058). Scanning never writes
inside a root; the catalog (`tidy/catalog.sqlite` in the data folder) is rebuildable by
rescanning and never authoritative. Every change applies at once and ends with a toast that has
**Undo**, duplicate decisions included; ⌘Z undoes the last change and History lists them all.
Nothing asks first except forgetting a folder. Before each step Tidy re-reads the file and skips
it if its size, mtime or ctime moved since the scan ("changed since the scan": rescan and apply
again). Undo reverses a change's finished steps, newest first.

| Action | What happens on disk | Undo |
| --- | --- | --- |
| Move to holding (and resolving duplicates) | The file moves into its root's holding folder, `tidy/holding/<root id>-<root name>/<batch>/<its path>`. A root on another volume holds in `.latch-works/oriel/holding/` at that volume's top, so a removal stays a rename; a root that is a whole volume holds in the data folder by copying. | Moved back, unless something now sits at the original path. |
| Clean up | System junk goes to holding, empty folders are removed, and extensions that do not match the bytes are renamed (an AVIF saved as `.jpg` becomes `.avif`). | Each step is reversed. |
| Move to… / Rename / Fix extension | Renamed in place, or moved to the chosen folder (copied then deleted across volumes, keeping mtime). | Moved back. |
| Convert, Shrink, remove a silent track | The result is written to `<target>.glazier-tmp`, checked (it decodes; dimensions, duration and tracks as planned; re-encodes at least 5% smaller), given the original's mtime and renamed into place; the original goes to holding. Video goes through the pinned ffmpeg. | The result goes to holding and the original comes back. |
| Restore (Holding, ⌘⌫) | The held file moves back to its original path. | — |
| Empty to Trash (Holding, ⇧⌘⌫) | Each holding batch goes to the system Trash (the Recycle Bin on Windows), without asking: the Trash is the safety net. | Only from the Trash. |

A file whose conversion came out no smaller is kept as it is, and Convert stops offering it
until its bytes change. Members of open duplicate sets are not converted until they are reviewed.
A converted file keeps the original's modification date, so date sorting in View and Pane View
holds, but not its creation date or extended attributes (Finder tags). A change cut short by a
crash or a forced quit is marked stopped on the next launch, and the `*.glazier-tmp` files
beside its pending targets are deleted; its finished steps stay finished and can be undone.

After every scan and change, background analysis fingerprints every still (a 64-bit perceptual
hash) and every video and animation (frames at 10, 30, 50, 70 and 90% of its length), and
measures each soundtrack's loudness: one whose loudest moment stays below −60 dBFS is silent.
It waits behind anything the owner asks for; Settings › Background analysis turns it off, after
which Overview offers **Check now**. Similar matches need the same aspect ratio (within 3%).

Tidy never talks to Pane View. To bring the web library in line afterwards, `lockstep plan`
(converted files show as new paths, their originals as missing), `lockstep push`, then
`lockstep prune`, or Sync's Plan, Push and Prune. Holding is outside every root and never
syncs; `.latch-works` is a system folder to `media-domain`, so no scan reads it.

## Keeping the two implementations in step

Each rule Oriel ports from a TypeScript package that Pane View, the Lockstep CLI or Gather Box
still use is pinned by vectors in `apps/oriel/conformance/<package>/` (`media-domain`,
`media-format`, `media-index`, `lockstep-core`). The package's Vitest suite checks that
TypeScript still produces them, and `cargo test` checks that Rust does. When a TypeScript rule
changes on purpose, rewrite the vectors and port the change:

```sh
ORIEL_UPDATE_VECTORS=1 pnpm --filter @latch-works/media-domain test
ORIEL_UPDATE_VECTORS=1 pnpm --filter @latch-works/media-format test
ORIEL_UPDATE_VECTORS=1 pnpm --filter @latch-works/media-index test
ORIEL_UPDATE_VECTORS=1 pnpm --filter @latch-works/lockstep-core test
```

Then `pnpm oriel:check` shows what Rust must change. Known differences are listed in the
tests themselves (the 19 Han pairs in `crates/core-domain/tests/conformance.rs`).

The rest is frozen: Oriel is the only implementation left, and these files are what it must
still produce. Nothing regenerates them; change one only with the Rust change that needs it.

- `conformance/glazier-core/` and `conformance/fingerprints/`: what glazier-core, Tidy's
  TypeScript engine, made of the committed archives and the fingerprint corpus before it was
  removed with Electron Oriel. Fingerprints match them only through the libvips build sharp
  ships; the Rust tests load it from `node_modules` (`ORIEL_LIBVIPS=<dylib>` points them at
  another).
- `conformance/glazier-core/smoke-fixture.json`: glazier-core's last report of the smoke fixture
  (`make-fixture.ts --profile smoke`), the baseline for a differential run on a larger archive
  than the committed one. It matched Oriel's with 0 differences when it was frozen:

  ```sh
  cd apps/oriel && cargo run --release -p oriel-core-tidy --example tidy_differential -- \
    ~/.latch-works/oriel-fixtures/spike-fixture-smoke /tmp/smoke-report.json \
    conformance/glazier-core/smoke-fixture.json
  ```
- `conformance/media-index/view-index.*`: the View index Electron Oriel's schema made.
- `conformance/lockstep-core/secret-storage/electron/`: a Sync profile and token Electron Oriel
  wrote, which Oriel must read.

## Video through libmpv

Video plays through libmpv (plan 063, decisions 4 and 7), which plays MKV, WebM, AVI, FLV and
ASF as well as MP4, and seeks AV1 exactly. `ORIEL_VIDEO=avplayer` plays through AVPlayer
instead, and the app falls back to AVPlayer by itself when no libmpv loads.
`ORIEL_MPV_RENDER=gl` (the default) draws through OpenGL into an IOSurface; `sw` draws in
software.

Oriel builds its own LGPL libmpv (decision 8) from pinned sources, in one command:

```sh
pnpm --filter @latch-works/oriel libmpv     # cargo run -p xtask -- libmpv
```

It is built from source because no prebuilt LGPL libmpv dylib exists: MPVKit's LGPL builds are
static archives, and IINA's and mpv's own builds are GPL.

- **What it builds.** mpv 0.41.0 (`-Dgpl=false`, libmpv only), FFmpeg 9.0.2 (no
  `--enable-gpl`, `--enable-nonfree` or `--enable-version3`; every demuxer, decoder and
  VideoToolbox, no encoders, muxers or network), libplacebo, dav1d (AV1 in software where
  VideoToolbox cannot), and libass with FreeType, FriBidi and HarfBuzz, which mpv requires. The
  pins, hashes, licences and flags are in `crates/xtask/src/libmpv/sources.rs`.
- **Where it goes.** `apps/oriel/.libmpv/<id>/`, git-ignored, with `.libmpv/current` pointing
  at it: 13 dylibs, 26 MB, each named `@rpath/…` and finding the others through
  `@loader_path`, ad hoc signed, for macOS 13 and later. Beside them are `manifest.json`
  (versions, hashes, flags, toolchain, and what the libraries report: each FFmpeg library says
  "LGPL version 2.1 or later"), `SHA256SUMS` and `licenses/`. `--out <dir>` builds the set
  somewhere else, to compare two builds.
- **How long.** 82 s from nothing on an M5 Pro, about 50 MB of downloads included; 78 s with the
  downloads cached. It is resumable: rerun it after an interruption and it carries on from the
  step that did not finish. The work tree is `apps/oriel/target/libmpv/` (sources, builds,
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
2. the file `ORIEL_LIBMPV=<dylib>` names;
3. the development build, `apps/oriel/.libmpv/current`;
4. IINA's libmpv (`/Applications/IINA.app`), read in place, and only when not running from a
   bundle.

The bundle's libmpv is the LGPL set. IINA's build is GPL: it is for development only, and a
bundled app never loads it, even with nothing else to load.

## Vendored libraries

libvips and libavif are not built here: they come prebuilt, each pinned by URL and SHA-256, and
are checked before anything unpacks them (the owner's decision of 2026-10-29). One command fetches
both, or the one named:

```sh
pnpm --filter @latch-works/oriel vendor     # cargo run -p xtask -- vendor [libvips] [libavif]
```

Each lands in `apps/oriel/.vendor/<name>/<id>/`, git-ignored, with `.vendor/<name>/current`
pointing at it, beside its licences, `manifest.json` (URLs, hashes, how each hash was checked
against its publisher, licences, every library's links and minimum macOS) and `SHA256SUMS`. 7 s
from nothing, 21 MB of downloads (kept in `apps/oriel/target/vendor/downloads/`); a rerun
checks the hashes and does nothing. The pins are in `crates/xtask/src/vendor/pins.rs`.

| Set | What | Size | macOS | Licence |
| --- | --- | --- | --- | --- |
| `libvips` | sharp's own build, `@img/sharp-libvips-darwin-arm64` 1.3.4 from npm (libvips 8.18.7, the one sharp 0.35.5 installs), its `lib/` as the package has it: one dylib that needs only the system | 18.2 MB | 11.0 | LGPL-3.0-or-later; the package's README lists each library inside |
| `libavif` | libavif 1.4.2 with aom 3.15.2, libvmaf 3.2.1 (aom links it) and dav1d 1.5.4 (libavif links it for decoding): Homebrew's `arm64_sequoia` bottles from its registry, renamed `@rpath/…` with `@loader_path` as their rpath and signed ad hoc again; aom's PATENTS comes from its source release | 6.3 MB, 4 dylibs | 15.0 | BSD-2-Clause, BSD-2-Clause-Patent |

- libavif publishes only command-line tools for macOS, and no other trusted prebuilt library
  has aom without bringing its own C++ runtime (conda-forge's), so the set is Homebrew's.
  Homebrew builds aom for macOS 15 and later only, so the set needs macOS 15.
- The vendored libvips is byte for byte the one in `node_modules`. The app finds libvips in its
  bundle's `Contents/Frameworks`, else the file `ORIEL_LIBVIPS` names, else the vendored set,
  else `node_modules` (`Vips::open_located` in `oriel-core-tidy`). The fingerprint tests still
  load `node_modules`' copy unless `ORIEL_LIBVIPS` names another.
- `oriel-avif` loads libavif from the app bundle's `Contents/Frameworks`, else the file
  `ORIEL_LIBAVIF` names, else `.vendor/libavif/current`. Its tests skip, saying so, until the
  set is vendored.

## Making the app

`pnpm --filter @latch-works/oriel bundle` (`cargo run -p xtask -- bundle`) makes
`apps/oriel/target/release/bundle/Oriel.app` (under `$CARGO_TARGET_DIR/release/bundle/`
when that is set) with:

| Part | Where | Size |
| --- | --- | --- |
| The app's binary, `cargo build --profile dist -p oriel` (`[profile.dist]`: the release build with fat LTO over one codegen unit), stripped of its symbol table with `strip -x` | `Contents/MacOS/oriel` | 25 MB |
| The LGPL libmpv set, built first if it is not | `Contents/Frameworks/` | 26.1 MB, 13 dylibs |
| The vendored libvips, fetched first if it is not | `Contents/Frameworks/` | 18.1 MB |
| The vendored libavif, fetched first if it is not, its local symbols stripped; libmpv's dav1d 1.5.4 serves it, under the same install name | `Contents/Frameworks/` | 5.1 MB, 3 dylibs |
| The pinned ffmpeg and ffprobe, fetched first if they are not (`oriel-tools`' own code) | `Contents/Resources/media-tools/` | 126 MB |
| Each set's licences and manifest | `Contents/Resources/licenses/<set>/` | |
| The repository's licence | `Contents/Resources/licenses/oriel/` | |
| FFmpeg's `COPYING.GPLv3` and `LICENSE.md` from its pinned source release, and `NOTICE.txt`: download URLs and hashes, ffmpeg's configure flags, the licence those flags make it (GPL-3.0-or-later) and where its source is | `Contents/Resources/licenses/media-tools/` | |
| The licence files of each of the 536 crates in the binary, listed in `README.txt` with each one's licence expression; the 62 that ship no licence file of their own point at shared MIT and Apache-2.0 texts | `Contents/Resources/licenses/rust-crates/` | |
| `index.json`, one entry per folder, which the About dialog lists | `Contents/Resources/licenses/` | |
| The icon, `assets/oriel-icon.icns` (Electron Oriel's artwork), `Info.plist` (`dev.traydr.latchworks.oriel`) | `Contents/` | |

205 MB in all, against Electron Oriel's 503 MB. `LSMinimumSystemVersion` is the newest macOS any
part needs, so the libavif set makes the app's macOS 15 and later (Oriel's own floor is 13).
The command checks that every library in `Contents/Frameworks` links only the system and the
others there, signs the whole ad hoc (`codesign --force --deep -s -`), checks it with
`codesign --verify --deep --strict`, and loads libmpv, libvips and libavif from the finished
bundle. Ad hoc signing runs on the Mac that built it. `ORIEL_MACOS_SIGN_IDENTITY` names a
Developer ID identity instead, signed with the hardened runtime and a timestamp as for Electron
Oriel (not yet tried with a real identity); notarizing is a follow-up (decision 15). The dist
build takes about 4.5 minutes from clean on an M5 Pro, and about 3 minutes after any change,
since fat LTO relinks the whole program; `cargo build --release`, which the spikes, examples and
benches use, keeps Cargo's defaults and its seconds-long rebuilds. The bundled binary has no
symbol table, so read a crash report against the unstripped build of the same UUID: `atos -o
<target>/dist/oriel`. The app carries no data: it uses
`~/.latch-works/oriel/` as a development build does.

### The DMG

`cargo run -p xtask -- dmg` (or `package`, which on macOS does the same) makes the bundle as above,
then `Oriel-<version>-arm64.dmg` beside it, verified with `hdiutil verify`. It prints the
image's path: `target/release/bundle/` (under `$CARGO_TARGET_DIR` when that is set). `dmg --app
<Oriel.app>` packs a bundle already made from this checkout instead of making it again.

The image is laid out as Electron Oriel's, whose Forge config gives appdmg the layout:

| | Oriel | Electron Oriel |
| --- | --- | --- |
| Volume | "Oriel", with the app's icon (`.VolumeIcon.icns` and the root's custom-icon flag) | "Oriel", the same icon |
| Window | 660 × 400, no toolbar, icons 128 px | the same |
| Icons | the app at (180, 180), the link to `/Applications` at (480, 180) | the same |
| Background | `apps/oriel/crates/xtask/installer/dmg-background.svg`, Electron Oriel's art reading "Drag Oriel onto Applications to install it." | the same art |
| Format | HFS+, compressed to ULFO (LZFSE, macOS 10.11 and later) | the same |

xtask does what appdmg does, in Rust and without AppleScript or Finder: it creates a blank HFS+
image with `hdiutil`, mounts it in the target folder, copies the app in with `ditto`, links
`/Applications`, joins the 1x and 2x pictures into one HiDPI TIFF in the hidden `.background`
folder with `tiffutil -cathidpicheck`, and copies the icon. It sets the Finder flags in
`com.apple.FinderInfo` itself (custom icon on the root, invisible on `.background` and
`.VolumeIcon.icns`), since `SetFile` comes only with Xcode. Then it writes the `.DS_Store`
(`crates/xtask/src/dmg/`): a `Bud1` buddy-allocated store with one B-tree leaf holding each
icon's `Iloc`, and the folder's `bwsp` (window bounds, no toolbar or sidebar), `icvp` (icon view,
128 px, background type 2) and `vSrn`, the two as binary property lists. `icvp` carries an alias
record pointing at the TIFF, as `macos-alias` writes it (its test checks it against the alias in
Electron Oriel's 0.1.4 DMG, byte for byte): the volume's name and mount point
(`/Volumes/Oriel`), the folder's and file's catalog IDs, and the path from the volume's root.
Finder resolves it by the volume's name and that path wherever the image is mounted. Last it
unmounts the image and converts it to ULFO.

The PNGs are Electron Oriel's own, rendered from the SVG at 660 × 400 and 1320 × 800 by sharp;
render both again (sharp, or resvg with the system's fonts) after changing the SVG. Finder hides the bottom line of the art behind the path and status bars when those are
on in Finder's settings, as it does for Electron Oriel's image.

Try an image without installing it:

```sh
hdiutil attach -nobrowse -mountpoint /tmp/oriel-dmg <image>
ditto "/tmp/oriel-dmg/Oriel.app" "/tmp/oriel-try/Oriel.app"
ORIEL_DATA_DIR=/tmp/oriel-try/data "/tmp/oriel-try/Oriel.app/Contents/MacOS/oriel"
hdiutil detach /tmp/oriel-dmg
```

**Installing.** Open the image and drag Oriel onto Applications. Started from anywhere else (the
mounted image, Downloads), the app offers to move itself, as Electron Oriel does: "Move to
Applications", "Not Now" (asks again next launch) or "Don't Ask Again" (remembered in
`shell/move-to-applications-declined`). Moving copies the bundle into `/Applications`
(`~/Applications` when that is not writable; Electron Oriel asks for an administrator instead),
replacing an older copy only when you say so and never one that is running, moves the old copy to
the Trash unless it is on a read-only volume (the image, or App Translocation's mount), and starts
again from Applications. Development builds, binaries outside a bundle and runs with
`ORIEL_DATA_DIR` set are not offered the move. A check sets `ORIEL_MOVE_OFFER=1` to be
offered it anyway, and `ORIEL_APPLICATIONS_DIR=<folder>` (read only in such a run) to move into
a scratch folder instead of Applications; the relaunch passes every `ORIEL_*` variable on.

**An unsigned copy someone else downloads.** The bundle is signed ad hoc, which runs on the Mac
that built it. A copy that arrives through a browser or AirDrop carries the quarantine attribute,
and Gatekeeper refuses an app with no Developer ID: macOS says it "cannot be opened" or "is
damaged". Either Control-click (right-click) the app in Finder, choose Open, then Open again in the
dialog (on macOS 15 and later: try to open it once, then System Settings > Privacy & Security >
Open Anyway), or clear the attribute once from Terminal:

```sh
xattr -dr com.apple.quarantine "/Applications/Oriel.app"
```

The owner builds it themselves on their own Mac, which needs neither (decision 19).

### Windows

`cargo run -p xtask -- package windows` makes a Velopack Setup.exe on Windows;
`package windows --stage-only [--exe <oriel.exe>]` lays out the folder it installs on any
system. [The Windows runbook](oriel-windows.md) has the rest.

## Measuring

`cargo run -p xtask -- measure` takes Phase 9's scorecard rows for Oriel the way the
scorecard took them, so a change can be measured again in the same units. It replaced the
scratch drivers Phase 9 used. From `apps/oriel`:

```sh
cargo run -p xtask -- bundle
cargo run -p xtask -- measure view --rounds 3          # the bundle in target/release/bundle
cargo run -p xtask -- measure scroll idle \
  --app base=/tmp/base/oriel --app mine=/tmp/mine/oriel   # an A/B, interleaved
```

| Row | What runs | What it reports | About |
| --- | --- | --- | --- |
| `cold-start` | View on the fixture's `stills/`, a fresh data folder | Launch to the first thumbnails; the stills listed; the app's CPU time to then | 3 s |
| `fill` | The same, `ORIEL_SPIKE_FILL=1` | Thumbnails made per second; stills without one; CPU time | 90 s |
| `scroll` | The fill's folder (its first screen evicted): 60 s at rest, the scroll at 5,000 px/s, 60 s at rest, 20 viewer steps | The warm start; memory and CPU 60 s after opening and after the scroll; frame times, long frames and CPU time in the scroll; the steps | 5 min |
| `warm-start` | The cold start's folder (its first screen on disk), 100 s at rest | The warm start; CPU from 30 to 90 s after the first thumbnails | 2 min |
| `video` | `mpv_spike sweep` on the first 10 videos of each codec, with a bundle's own libmpv | Open, exact and fast seek, medians per codec | 1 min |
| `library` | The Library spike, 100,000 rows, the scroll at 30,000 px/s | Sorts, scroll, selection, memory | 2 min |
| `idle-view`, `idle-tidy`, `idle-sync` | Each mode with nothing open | CPU from 30 to 90 s after launch; memory | 90 s each |
| `sync` | `oriel-core-sync`'s `sync_bench` example: plan, then push, of `--sync-source` (the smoke fixture) with a fresh hash cache | Plan and push times; the plan's counts | seconds |
| `tidy` | The fixture added as a root, on Overview | Launch to a finished Overview (the app and its ffmpeg and ffprobe quiet for 5 s); CPU time; memory; CPU at rest after; the catalog's counts | 6 min on the 21k fixture |

`view` runs the four View rows, `idle` the three modes, and `all` every row (Sync only with
`--sync-url`). A row that reuses another's data folder brings it along: `scroll` runs `fill`, and
`warm-start` runs `cold-start`.

- **Apps.** `--app [<label>=]<path>` takes an `Oriel.app` or a binary, A, B… unless labelled.
  With several, each round interleaves them, A, B then B, A, for every row. `video` and `sync`
  run a tool built from source: for a binary, the `examples/mpv_spike` and `examples/sync_bench` beside it
  (a cargo target's `release/` folder has both once built), so an A/B measures each side's own
  code; otherwise the workspace's, built in release before the first round. The Library and Tidy
  rows bring the window to the front, where GPUI draws it: `open -a` for a bundle, System Events
  by process id for a binary.
- **Output.** `--out <folder>` (default `/tmp/oriel-measure/run-<seconds>`). `<app>/r<round>/`
  holds each run's data folder, the spike's log, the app's stderr and `<row>.json`: every event,
  the readings from outside at each, the exit code and the load average before. `summary.md` is
  the table printed at the end, each measure's median with its spread (min–max) per app and each
  app against the first; `summary.json` has the same numbers round by round. Both are rewritten
  after each round, so a series cut short still has a table.
- **What it reads.** The spikes' own events and memory, as the scorecard did (a spike moves on
  the moment it writes a reading, so its own is the one at rest); CPU time, resident memory and
  footprint from outside through `proc_pid_rusage`, at each event and for the modes at rest; the
  `footprint` tool only at rest, never while something is timed; the Tidy catalog's counts through `/usr/bin/sqlite3`, once the
  app has quit. Each launch drops the shell's `ORIEL_*` variables; `--env K=V` adds one to
  every launch. `--fixture` moves View's, video's and Tidy's fixture (the 21k fixture by default);
  Tidy's must be in `~/.latch-works/oriel-fixtures`, which the run's data folder's `sandbox`
  links to.
- **Sync** needs `--sync-url`, and refuses any URL but `http://127.0.0.1` or
  `http://localhost` (or `https://`), with no credentials; `--sync-token` defaults to the e2e
  stack's. It pushes into the target as it finds it, so only the first push into a fresh target
  uploads; the plan's counts show which it was. For the scorecard's push into an empty target,
  start `e2e/scripts/start-pane-view.ts` before each run (`--rounds 1`): it drops and recreates
  the `latch_works_e2e` database, and each push writes the smoke fixture's 247 files to the
  `latch-works-e2e` bucket on the local RustFS. Nothing goes to a remote URL.

The spikes' variables, for a run by hand, are documented at the top of each spike:
- View's in `crates/mode-view/src/spike.rs`; `ORIEL_SPIKE_WORKFLOWS=1` times each sort order,
  Shuffle, Refresh and comic mode in place of the scroll and the steps;
- the Library's in `crates/mode-tidy/src/spike.rs`;
- Tidy's pages in `crates/mode-tidy/src/page_spike.rs`: `ORIEL_SPIKE_TIDY=<log>` runs page
  switches, sorts, typing, filters, the Inspector, list and grid scrolls, Duplicates' sets, its
  version grid's scroll, the loupe and a rescan on the root Tidy shows, each step with its CPU
  time on the main thread and in all; `ORIEL_SPIKE_TIDY_ONLY=pages,rescan,redraw,
  library,grid,duplicates` picks groups and `ORIEL_SPIKE_TIDY_HOLD=1` keeps the app open;
- the shell's in `crates/app/src/spike.rs`: `ORIEL_SPIKE_SHELL=<log>` times the launch, each
  mode switch and Settings at each section.

`mpv_spike`'s own switches mirror the gallery: `ORIEL_SPIKE_SILENT=1` (a preview with sound off),
`ORIEL_SPIKE_PREWARM=<ms>` (an engine started that long before the first open, as hovering a video
tile does), `ORIEL_SPIKE_PRIME=<ms>` (an engine started and primed that long before, as View
showing a folder with videos does; it plays nothing, and makes its clip once with the pinned
ffmpeg, in `<data>/view/cache/`), `ORIEL_SPIKE_WARM=<video>` (the first open on an engine a player
gave back) and `ORIEL_SPIKE_REST=<seconds>` (the footprint after that rest). Video through
AVPlayer, which `video_spike` forces: `cargo run --release -p oriel-media --example video_spike --
<single|tiles|sweep|errors>`, and the same through libmpv with `--example mpv_spike` (also
`verify`, `colour`, and `rest <seconds>`, which opens nothing and prints the footprint every 5 s:
with `ORIEL_SPIKE_PRIME=0`, what a primed engine holds while it waits and after it shuts down).

Phase 9's scorecard, and how its rows map to these, is in
[docs/research/oriel-rs/scorecard.md](../research/oriel-rs/scorecard.md) under "Run it again".

Tidy's engine has two timers of its own, headless, in `oriel-core-tidy`'s examples:

```sh
# The scan and analysis pass by pass (wall, CPU in the app and in ffmpeg, cores busy), Overview's
# and Duplicates' queries, memory after; --rescans n, --probe (a UI-priority thread's lateness),
# --changes (Convert, Shrink, Clean up, Tidy up and their undos, on a copy), --hold <s>.
cargo run --release -p oriel-core-tidy --example tidy_timing -- <root> <data-folder> [flags]
# Per still, at several counts at once, checking every round makes the same results:
# fingerprint (decode and pHash), probe (header) or convert (decode and AVIF encode).
cargo run --release -p oriel-core-tidy --example stills_timing -- \
  fingerprint|probe|convert <folder> <scratch> 4,8,18
# Each video's fingerprint frames, made one ffmpeg run per keyframe and five single runs, checked
# byte for byte against each other and timed.
cargo run --release -p oriel-core-tidy --example video_frames -- <folder>
```

The root must be one Tidy admits: a data folder whose `sandbox` links to the fixtures' folder, as
the `tidy` row does, or a copy under that `sandbox` for `--changes`.

Sync's timer is `oriel-core-sync`'s `sync_bench` example (the `sync` row's), against the e2e
Pane View, which it refuses to leave this machine for:

```sh
# Push at a fixed upload width (1 to 8), or adaptive (auto, the default). The JSON line's
# "widths" lists each width the queue ran at, as [ms from the first upload, width].
cargo run --release -p oriel-core-sync --example sync_bench -- push <source> <hash-cache> auto|N
# Plans, then prunes; "prune_ms" is the prune alone.
cargo run --release -p oriel-core-sync --example sync_bench -- prune <source> <hash-cache>
# A slow link for the adaptive width: listens on 127.0.0.1:<listen> and forwards to
# 127.0.0.1:<upstream> with the upload direction held to <bytes/s> across every connection.
cargo run --release -p oriel-core-sync --example throttle_proxy -- 9100 9000 2000000
```

To push through the proxy, start the e2e Pane View with `S3_ENDPOINT=http://127.0.0.1:9100`
(`E2E_SKIP_BUILD=1 S3_ENDPOINT=… pnpm --filter @latch-works/e2e exec tsx
scripts/start-pane-view.ts`): the upload URLs it signs then go through the proxy to the local
RustFS, and the signatures still hold, since the proxy passes the bytes and the Host header
through unchanged. Each start recreates `latch_works_e2e`, so restart it before each push that
should upload everything.

Reports carry numbers only: the owner's library is never screenshotted or uploaded.
