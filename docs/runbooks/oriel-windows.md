# Oriel on Windows

Oriel on Windows is best effort (plan 063, decision 21): the workspace builds for Windows and
packages from here, and an agent on the owner's Windows machine finishes it. This runbook is that
agent's handoff. The macOS runbook is [oriel.md](oriel.md); its rules hold here too: every
check runs with `ORIEL_DATA_DIR` set to a scratch folder, on throwaway archives, and never
reads or writes the owner's data folder, `%USERPROFILE%\.latch-works\oriel`.

## Prerequisites

| | Windows 11 x64 |
| --- | --- |
| Rust | rustup (`rustup-init.exe`); `apps/oriel/rust-toolchain.toml` pins the toolchain and its default host, `x86_64-pc-windows-msvc` |
| C toolchain | Visual Studio 2022 Build Tools: "Desktop development with C++", with the MSVC compiler and a Windows 11 SDK. rusqlite builds SQLite and libwebp-sys builds libwebp with it; GPUI's release build compiles its shaders with the SDK's `fxc.exe` (`GPUI_FXC_PATH` names another) and embeds its manifest with `rc.exe` |
| vpk | The .NET 8 SDK or later, then `dotnet tool install -g vpk --version 1.3.39-g8d2844f`, the version Electron Oriel packs with and the `velopack` crate the app links |
| curl, tar | Windows' own, in `System32` (Windows 10 1803 and later); the xtask fetches with them |
| Node and pnpm | Only for the conformance vectors and the e2e suite, as on macOS |

## Build, run and package

From `apps\oriel`:

```powershell
cargo run -p xtask -- vendor                 # on Windows: libavif and its DLLs
cargo build -p oriel                      # a debug build, with a console for the log
$env:ORIEL_DATA_DIR = "$env:TEMP\oriel-check"
cargo run -p oriel

cargo run -p xtask -- package windows        # the dist build, the stage, then Setup.exe
cargo run -p xtask -- package windows --stage-only   # the stage alone
```

`package windows` stages `target\release\package\windows\Oriel\`, the folder Setup.exe
installs to `%LocalAppData%\Oriel\current`:

| Part | Where | From |
| --- | --- | --- |
| `oriel.exe` | the folder | `cargo build --profile dist -p oriel` (fat LTO), or `--exe <path>` |
| `libmpv-2.dll` | the folder | shinchiro's `mpv-dev-x86_64-20261021-git-e471496c56.7z`, SHA-256 `efc719ef…ea633`; **GPL**, fine for the owner's own use (decision 19) |
| `libvips-42.dll` | the folder | `@img/sharp-libvips-win32-x64` 1.3.4 (libvips 8.18.7, with libheif and aom), SHA-256 `3d6d4c90…87114`, checked against npm's sha512 |
| `libavif-16.dll` and the 10 DLLs it needs | `libavif\` | MSYS2's UCRT64 packages (below), 28 MB; `oriel-avif` loads libavif from there with that folder searched first for the rest |
| `ffmpeg.exe`, `ffprobe.exe` | `media-tools\` | `oriel-tools`' win32-x64 pin, gyan.dev's 9.0.2 full build (GPL-3.0-or-later), Electron Oriel's |
| The notices | `licenses\` | each part's licence and a NOTICE with its URL, hash and source; the 541 Rust crates of the Windows build; `index.json`, which About lists |

The libavif set is libavif 1.4.2, the Mac's version, with every DLL its imports name, each package
pinned by SHA-256 in `crates/xtask/src/libavif_windows.rs` and checked against the `%SHA256SUM%`
MSYS2's signed `ucrt64.db` listed on 2026-10-31: `libavif` 1.4.2-1, `aom` 3.15.3-1, `dav1d` 1.5.4-1,
`rav1e` 0.8.1-1, `svt-av1` 4.2.0-1, `libyuv` 1924.r2921.644251f25-2, `libwebp` 1.6.0-1 (for
`libsharpyuv-0.dll`), `libjpeg-turbo` 3.2.1-1 (libyuv's `libjpeg-8.dll`), and MinGW's runtime,
`libstdc++` and `libgcc` 16.2.0-6 (GPL-3.0-or-later with the GCC Runtime Library Exception) and
`libwinpthread` 14.0.0.r569. The zstd comes off in Rust (`ruzstd`); bsdtar unpacks the tar. The
step refuses a set where a DLL imports one that neither the set nor Windows has.
`licenses\libavif\` holds each package's licence files and a NOTICE with every URL and hash.

Then `vpk pack --packId Oriel --packVersion <version> --packTitle "Oriel" --packAuthors Traydr
--runtime win-x64 --packDir <stage> --mainExe oriel.exe --icon apps\oriel\assets\oriel-icon.ico
--outputDir target\release\package\windows\velopack`, Electron Oriel's arguments less the MSI and
the splash, and the files are renamed `Oriel-<version>-win-x64-Setup.exe` and
`-Portable.zip`. The pack id and title are Electron Oriel's, `Oriel`. Downloads are
cached in `apps\oriel\target\vendor\downloads`, each checked against its SHA-256.

The app answers Velopack's hooks first thing in `main` (`VelopackApp::build().run()`): Velopack's
docs say the app must, and kill an app that has not exited within 15 to 30 seconds of a hook. It
never checks for updates (decision 19). Uninstalling removes `%LocalAppData%\Oriel` and leaves
the data in `%USERPROFILE%\.latch-works\oriel`.

## What was done from the Mac, and how it was checked

Nothing here has run on Windows. On the Mac, 2026-10-31:

- `cargo check --workspace --all-targets` and `cargo clippy … -- -D warnings` pass for
  `x86_64-pc-windows-gnullvm`, built with llvm-mingw 20261020 (open source; its headers are
  mingw-w64's), which compiles the C in rusqlite and libwebp-sys. For `x86_64-pc-windows-msvc`
  every crate without C checks too; the C needs MSVC's headers, which were not fetched.
- A debug `oriel.exe` links for gnullvm (1 GB with debug info; a release build needs `fxc.exe`).
- `package windows --stage-only --exe <that exe>` stages the folder above: 1.7 GB with the debug
  exe.

So all of it is compile-checked only:

- **Data root**: `%USERPROFILE%\.latch-works\oriel` (std's `home_dir` reads `USERPROFILE`).
- **Folder reads**: the portable `read_dir` and `metadata` path beside macOS's
  `getattrlistbulk` (`oriel-core-index`'s `folder.rs`). Tidy's walk reads each file's volume
  serial number and file index for `dev` and `ino`, as libuv does, so hard links are found
  (`oriel_runtime::fs_meta`).
- **ctime is NTFS's change time**, as libuv's `st_ctime` is: `fs_meta::change_time` opens the
  file for its attributes (sharing everything) and reads `ChangeTime` from `FILE_BASIC_INFO`;
  `fs_meta::identity` reads it with the volume serial and file index in one open. Tidy's walk,
  its executor's checks, its hash check, and the Sync scan's fingerprints
  (`ArchiveFileFingerprint::of`) use it, so the ctimes in Electron Oriel's catalogs and hash
  cache match.
  View's catalog and thumbnail keys use mtime and size only. Sync's push still records none
  there until `core-sync-push.rs.patch` (2026-10-31, windows-2) lands.
- **Paths as Node writes them**: `oriel_runtime::paths::canonicalize` is `fs.realpath`: std's
  `canonicalize` gives `\\?\C:\…` on Windows, which libuv strips. Tidy's roots go through it.
  `paths::namespaced` is `path.toNamespacedPath`, the `\\?\` form libvips needs past 260
  characters (plan 062): every path Tidy, View's thumbnails and the viewer hand libvips gets it,
  and libvips keeps no files open (`vips_cache_set_max_files(0)`, sharp's `cache({ files: 0 })`).
  std's own file calls add the prefix themselves; ffmpeg handled long paths in plan 062.
- **Roots' names**: the overlap check and `is_within` ignore case on Windows, as `path.relative`
  does there. Reserved names (`CON`, `NUL`, …) and names ending in a dot or a space are not
  handled, as Electron Oriel does not handle them.
- **Holding on another drive**: a root on `D:\Photos` with the data on `C:` holds in
  `D:\.latch-works\oriel\holding`, by rename; a whole drive (`D:\`) holds in the data folder,
  by copy (`HoldingPlaces::on_volume`, by volume serial, as glazier-core by `dev`). A sandboxed
  run (`ORIEL_DATA_DIR` set) holds in the data folder on every drive.
- **Files held open** (plan 062): a sharing or lock violation (`ERROR_SHARING_VIOLATION`,
  `ERROR_LOCK_VIOLATION`) or a denied access is "in use": the step fails with "Another program
  has … open, so it was left as it was.", and Undo says to close it and Undo again. A move across
  drives whose original will not delete takes its copy back out, so nothing is left in two places.
- **Explorer's files**: `desktop.ini`, `Thumbs.db` and `ehthumbs*.db` are left out like
  `.DS_Store`, and leave with their empty folder; a folder Explorer marked read-only that
  refuses to go has the mark taken off for its removal (put back if it still stays).
- **Holding's batch names** read Windows' own local time
  (`SystemTimeToTzSpecificLocalTimeEx`), not the C library's, which reads a POSIX `TZ`.
- **Emptying holding** moves each batch to the Recycle Bin through the shell's `IFileOperation`,
  with Chromium's flags for `shell.trashItem` (no UI, an undo record, `FOFX_RECYCLEONDELETE`) and
  its progress sink, which stops an item the Recycle Bin would delete outright rather than keep.
  It runs on a thread of its own, a single-threaded apartment.
- **Opening and Reveal**: GPUI's own (`ShellExecuteW`, and `SHOpenFolderAndSelectItems` in
  Explorer).
- **One instance per data folder**: a named mutex, `Local\dev.traydr.latchworks.oriel-<hash of
  the data folder>`; a second launch writes its paths into the pipe of the same name and exits, and
  the first opens them in View, or comes to the front when there are none
  (`crates/app/src/single_instance.rs`).
- **The title bar**: the window draws its own, as on macOS: GPUI Kit's `TitleBar`, with the app's
  menus in it through GPUI Kit's `AppMenuBar` and the caption buttons Windows hit-tests itself
  (`windows_frame.rs`). The menus follow Electron Oriel's Windows template: no app menu; File ends
  with Settings… and Exit; Window has Minimize and Close; Help has About.
- **Progress**: the taskbar button's (`ITaskbarList3`) while a push or a Tidy change runs.
- **Video**: libmpv's software renderer (`hwdec=d3d11va-copy`), each frame a BGRA image GPUI
  draws with `img()`: GPUI's `surface()` is macOS only.
- **Stills**: libvips decodes them (AVIF and HEIC through its libheif, with aom), the same
  library Tidy loads, then `image` scales them down; frames in memory decode through `image`.
- **Tidy's Convert**: oriel-avif loads `libavif\libavif-16.dll` beside the exe (then
  `avif.dll` or `libavif-16.dll` beside it, `ORIEL_LIBAVIF`, and in development
  `.vendor\libavif-windows`), with `LOAD_WITH_ALTERED_SEARCH_PATH`, so its DLLs resolve from its
  own folder.
- **The exe's icon and version**: `crates/app/build.rs` writes an `.rc` with Electron Oriel's
  `oriel-icon.ico` (16 to 256 pixels) as icon 1, which GPUI also loads for the window, and a
  `VERSIONINFO` (Oriel, the crate's version, Traydr), compiled by `embed-resource`: rc.exe on
  MSVC, windres or llvm-rc for MinGW. The gnullvm debug exe carries ICON, GROUP_ICON,
  VERSIONINFO and GPUI's manifest (`llvm-readobj --coff-resources`).
- **Logging off with work running** (`terminate.rs`): every top-level window on GPUI's thread is
  subclassed; while a push or a Tidy change runs, `WM_QUERYENDSESSION` answers no with
  `ShutdownBlockReasonCreate` ("Oriel is finishing a push or a Tidy change, and quits when it
  is done.") and hands the quit to the guard once, which hides the window and quits when the work
  ends. `WM_ENDSESSION` with the session going on takes the reason down; with it ending ("Shut
  down anyway"), GPUI quits at once.
- **Quick Look** opens the file in its default app; `QUICK_LOOK_LABEL` reads "Open in Default
  App" off macOS, once `mode-tidy-quick-look-label.patch` puts it in the menus and the shortcut
  sheet.
- A release build is a GUI program (no console window).

Checked from the Mac on 2026-10-31 (windows-2), with the platform agent's llvm-mingw environment:
`cargo clippy --workspace --target x86_64-pc-windows-gnullvm --all-targets -- -D warnings`
passes, `cargo build -p oriel --target x86_64-pc-windows-gnullvm` links, and
`cargo run -p xtask -- vendor libavif-windows` fetches, checks and lays out the libavif set.

## Stubbed

- [x] ~~**Trash**~~: the Recycle Bin, above.
- [x] ~~**Quits from the system**~~: answered, above.
- [x] ~~**The exe's icon**~~: embedded, above.
- **Quick Look**: opens the file in its default app instead, as decided; the label says so once
  the patch lands.
- **Macintosh wording**: Tidy's menus and shortcut sheet say "Show in Finder" and ⌘ on Windows
  too (mode-tidy's, not this runbook's).
- **The measuring tools** (`xtask measure`, the spikes' footprints, `core-tidy`'s timers) read
  macOS's process counters; on Windows they print zeros or refuse.

## To check on Windows

Each on a throwaway archive with `ORIEL_DATA_DIR` set, as plan 062 ran them for Electron Oriel:

- [ ] `cargo test --workspace` and `cargo clippy --workspace --all-targets -- -D warnings`; the
      conformance vectors, Tidy's differential runs and the GPUI tests that port the e2e cases.
      Symlink tests need developer mode.
- [ ] **The video gate (plan 063, Phase 8): 60 fps at 1080p.** STOP and report if it fails.
      `cargo run --release -p oriel-media --example mpv_spike -- sweep` with
      `ORIEL_LIBMPV=<libmpv-2.dll>`, then the viewer on the fixture's 1080p and 4K videos.
- [ ] Stills and AVIF in View and Tidy; fingerprints equal glazier-core's (libvips 8.18).
- [ ] **Convert to AVIF**: the staged `libavif\` loads (Settings or the log names
      `libavif-16.dll`), a still converts, and the file opens in Photos. Then without
      `libavif\`: Convert says no libavif was found.
- [ ] **ctime**: `fs.statSync(f).ctimeMs` in Node equals the catalog's `ctime_ms` after a scan
      (whole milliseconds); `attrib +r` alone moves it; a scan of a catalog Electron Oriel made
      hashes nothing again.
- [ ] **Recycle Bin**: Empty Holding puts each batch in the Recycle Bin, restorable; a batch on a
      drive with the Recycle Bin off fails with a message and stays in holding.
- [ ] **Logging off during a push**: Windows' screen names Oriel with the reason; the app
      quits when the push ends and the sign-out goes on; "Sign out anyway" quits at once.
- [ ] **The exe**: Explorer shows Oriel's icon and, in Properties › Details, "Oriel" and the
      version; the taskbar and the window show the icon.
- [ ] **Files held open**: a video playing in Duplicates, a file View has open, one Defender is
      scanning: the step fails with a readable message and nothing is half moved.
- [ ] **Replacing in place**: Shrink's MP4 to MP4, and Undo with the output open elsewhere.
- [ ] **Drives**: the archive on `D:` with data on `C:` (holding by rename in
      `D:\.latch-works\oriel\holding`, without `ORIEL_DATA_DIR`), and a whole drive as the
      root (holding by copy); Undo both. Empty Holding refuses the `D:` batches today ("not one
      of Tidy's holding folders": `empty_holding` admits only `<data>\holding`), on macOS too.
- [ ] **Long paths**: past 260 characters through the scan, fingerprints (libvips refused them in
      Electron Oriel until paths were given as `\\?\`), thumbnails, ffprobe and Shrink.
- [ ] **Names**: Japanese and other non-ASCII names through ffmpeg's arguments and libvips.
- [ ] **Explorer's files**: `desktop.ini` (hidden, system, read-only folder) and `Thumbs.db`.
- [ ] **Hard links**: `mklink /H` a picture; Duplicates frees nothing for it.
- [ ] **One instance**: a second launch with a folder opens it in the first; without one it
      brings the first to the front; a check's run with its own data folder starts beside it.
- [ ] **Setup.exe**: installs silently (`--silent`) to `%LocalAppData%\Oriel\current`, starts,
      shows About's licences, uninstalls cleanly, and leaves the data folder.
- [ ] The title bar: dragging, double-click to maximize, snap layouts on the maximize button,
      the menus by mouse and by Alt; the taskbar progress during a push.

## Known risks

- **Video speed.** Every frame is converted to BGRA on the CPU, copied back from the GPU's decoder,
  and uploaded to a new texture: twice the copies of the macOS path. 1080p60 is likely, 4K is
  not. If it falls short, mpv's D3D11 render API into a shared texture is the next step, which
  needs a GPUI surface on Windows (a `gpui-pre` change).
- **Thumbnails cost more** than on macOS: libvips decodes each still at full size before the
  scale down. `vips_thumbnail` decodes at the reduced size and is the fix if the fill is slow.
- **libmpv is GPL** and large (121 MB); the installed folder comes to about 620 MB, most of it
  ffmpeg's two 217 MB programs.
- **Stat costs an extra open on Windows**: the change time, volume serial and file index come
  from a handle, as libuv's `stat` gets them, so Tidy's walk and the Sync scan open each file
  once more than `metadata` does.
- **MSYS2 prunes old packages** from its repository in time; a pin that 404s needs the next
  versions' hashes from `ucrt64.db`, and `vendor libavif-windows` to check the closure again.
- The build is unsigned: SmartScreen warns on Setup.exe ("More info", then "Run anyway").
