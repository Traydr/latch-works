# Oriel RS on Windows

Oriel RS on Windows is best effort (plan 063, decision 21): the workspace builds for Windows and
packages from here, and an agent on the owner's Windows machine finishes it. This runbook is that
agent's handoff. The macOS runbook is [oriel-rs.md](oriel-rs.md); its rules hold here too: every
check runs with `ORIEL_RS_DATA_DIR` set to a scratch folder, on throwaway archives, and never
reads or writes Electron Oriel's folders (`%USERPROFILE%\.latch-works\{oriel,frame-view,glazier,
lockstep,lockstep.json,hash-cache}`, `%APPDATA%\Oriel`).

## Prerequisites

| | Windows 11 x64 |
| --- | --- |
| Rust | rustup (`rustup-init.exe`); `apps/oriel-rs/rust-toolchain.toml` pins the toolchain and its default host, `x86_64-pc-windows-msvc` |
| C toolchain | Visual Studio 2022 Build Tools: "Desktop development with C++", with the MSVC compiler and a Windows 11 SDK. rusqlite builds SQLite and libwebp-sys builds libwebp with it; GPUI's release build compiles its shaders with the SDK's `fxc.exe` (`GPUI_FXC_PATH` names another) and embeds its manifest with `rc.exe` |
| vpk | The .NET 8 SDK or later, then `dotnet tool install -g vpk --version 1.3.39-g8d2844f`, the version Electron Oriel packs with and the `velopack` crate the app links |
| curl, tar | Windows' own, in `System32` (Windows 10 1803 and later); the xtask fetches with them |
| Node and pnpm | Only for the conformance vectors and the e2e suite, as on macOS |

## Build, run and package

From `apps\oriel-rs`:

```powershell
cargo build -p oriel-rs                      # a debug build, with a console for the log
$env:ORIEL_RS_DATA_DIR = "$env:TEMP\oriel-rs-check"
cargo run -p oriel-rs

cargo run -p xtask -- package windows        # the dist build, the stage, then Setup.exe
cargo run -p xtask -- package windows --stage-only   # the stage alone
```

`package windows` stages `target\release\package\windows\Oriel RS\`, the folder Setup.exe
installs to `%LocalAppData%\OrielRS\current`:

| Part | Where | From |
| --- | --- | --- |
| `oriel-rs.exe` | the folder | `cargo build --profile dist -p oriel-rs` (fat LTO), or `--exe <path>` |
| `libmpv-2.dll` | the folder | shinchiro's `mpv-dev-x86_64-20261021-git-e471496c56.7z`, SHA-256 `efc719ef…ea633`; **GPL**, fine for the owner's own use (decision 19) |
| `libvips-42.dll` | the folder | `@img/sharp-libvips-win32-x64` 1.3.4 (libvips 8.18.7, with libheif and aom), SHA-256 `3d6d4c90…87114`, checked against npm's sha512 |
| `ffmpeg.exe`, `ffprobe.exe` | `media-tools\` | `oriel-tools`' win32-x64 pin, gyan.dev's 9.0.2 full build (GPL-3.0-or-later), Electron Oriel's |
| The notices | `licenses\` | each part's licence and a NOTICE with its URL, hash and source; the 541 Rust crates of the Windows build; `index.json`, which About lists |

Then `vpk pack --packId OrielRS --packVersion <version> --packTitle "Oriel RS" --packAuthors Traydr
--runtime win-x64 --packDir <stage> --mainExe oriel-rs.exe --icon apps\oriel\media\oriel-icon.ico
--outputDir target\release\package\windows\velopack`, Electron Oriel's arguments less the MSI and
the splash, and the files are renamed `Oriel-RS-<version>-win-x64-Setup.exe` and
`-Portable.zip`. The pack id `OrielRS` installs beside Electron Oriel's `Oriel`. Downloads are
cached in `apps\oriel-rs\target\vendor\downloads`, each checked against its SHA-256.

The app answers Velopack's hooks first thing in `main` (`VelopackApp::build().run()`): Velopack's
docs say the app must, and kill an app that has not exited within 15 to 30 seconds of a hook. It
never checks for updates (decision 19). Uninstalling removes `%LocalAppData%\OrielRS` and leaves
the data in `%USERPROFILE%\.latch-works\oriel-rs`.

## What was done from the Mac, and how it was checked

Nothing here has run on Windows. On the Mac, 2026-10-31:

- `cargo check --workspace --all-targets` and `cargo clippy … -- -D warnings` pass for
  `x86_64-pc-windows-gnullvm`, built with llvm-mingw 20261020 (open source; its headers are
  mingw-w64's), which compiles the C in rusqlite and libwebp-sys. For `x86_64-pc-windows-msvc`
  every crate without C checks too; the C needs MSVC's headers, which were not fetched.
- A debug `oriel-rs.exe` links for gnullvm (1 GB with debug info; a release build needs `fxc.exe`).
- `package windows --stage-only --exe <that exe>` stages the folder above: 1.7 GB with the debug
  exe.

So all of it is compile-checked only:

- **Data root**: `%USERPROFILE%\.latch-works\oriel-rs` (std's `home_dir` reads `USERPROFILE`).
- **Folder reads**: the portable `read_dir` and `metadata` path beside macOS's
  `getattrlistbulk` (`oriel-core-index`'s `folder.rs`). Tidy's walk reads each file's volume
  serial number and file index for `dev` and `ino`, as libuv does, so hard links are found
  (`oriel_runtime::fs_meta`). Its ctime is the last write time: std does not read NTFS's change
  time, which libuv's `st_ctime` is.
- **Opening and Reveal**: GPUI's own (`ShellExecuteW`, and `SHOpenFolderAndSelectItems` in
  Explorer).
- **One instance per data folder**: a named mutex, `Local\dev.traydr.latchworks.oriel-rs-<hash of
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
- **Tidy's Convert**: oriel-avif finds `avif.dll` or `libavif-16.dll` beside the exe, or
  `ORIEL_RS_LIBAVIF`, but none is pinned or staged yet, so Convert's AVIF encode fails saying no
  libavif was found. The choice is the next agent's: MSYS2's UCRT64 `libavif` with its aom and
  dav1d, or a CMake build of libavif with aom.
- A release build is a GUI program (no console window).

## Stubbed

- **Trash**: emptying holding fails with "Moving … to the Trash is not ported to this platform
  yet." The Windows equivalent is `IFileOperation` with `FOFX_RECYCLEONDELETE`, or `SHFileOperationW`
  with `FOF_ALLOWUNDO`.
- **Quick Look**: opens the file in its default app instead.
- **Quits from the system** (logging out with a push running): macOS's are answered in
  `terminate.rs`; Windows' `WM_QUERYENDSESSION` is not, so the app quits at once.
- **The exe's icon**: Setup.exe and Update.exe carry Oriel's icon, but `oriel-rs.exe` embeds none,
  so its shortcuts show Windows' default. An `embed-resource` build script in `crates/app` fixes it.
- **The measuring tools** (`xtask measure`, the spikes' footprints, `core-tidy`'s timers) read
  macOS's process counters; on Windows they print zeros or refuse.

## To check on Windows

Each on a throwaway archive with `ORIEL_RS_DATA_DIR` set, as plan 062 ran them for Electron Oriel:

- [ ] `cargo test --workspace` and `cargo clippy --workspace --all-targets -- -D warnings`; the
      conformance vectors, Tidy's differential runs and the GPUI tests that port the e2e cases.
      Symlink tests need developer mode.
- [ ] **The video gate (plan 063, Phase 8): 60 fps at 1080p.** STOP and report if it fails.
      `cargo run --release -p oriel-media --example mpv_spike -- sweep` with
      `ORIEL_RS_LIBMPV=<libmpv-2.dll>`, then the viewer on the fixture's 1080p and 4K videos.
- [ ] Stills and AVIF in View and Tidy; fingerprints equal glazier-core's (libvips 8.18).
- [ ] **Files held open**: a video playing in Duplicates, a file View has open, one Defender is
      scanning: the step fails with a readable message and nothing is half moved.
- [ ] **Replacing in place**: Shrink's MP4 to MP4, and Undo with the output open elsewhere.
- [ ] **Drives**: the archive on `D:` with data on `C:` (holding by rename on `D:`), and a whole
      drive as the root (holding by copy); Undo both. `holding.rs` has no Windows path for the
      root's own volume yet (it holds in the data folder).
- [ ] **Long paths**: past 260 characters through the scan, fingerprints (libvips refused them in
      Electron Oriel until paths were given as `\\?\`), thumbnails, ffprobe and Shrink.
- [ ] **Names**: Japanese and other non-ASCII names through ffmpeg's arguments and libvips.
- [ ] **Explorer's files**: `desktop.ini` (hidden, system, read-only folder) and `Thumbs.db`.
- [ ] **Hard links**: `mklink /H` a picture; Duplicates frees nothing for it.
- [ ] **One instance**: a second launch with a folder opens it in the first; without one it
      brings the first to the front; a check's run with its own data folder starts beside it.
- [ ] **Setup.exe**: installs silently (`--silent`) to `%LocalAppData%\OrielRS\current`, starts,
      shows About's licences, uninstalls cleanly, and leaves the data folder.
- [ ] **The import of Electron Oriel's data** from a synthetic copy of its Windows layout.
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
- **ctime** is the last write time, so a change of attributes alone is not seen, and an imported
  Electron Oriel catalog's ctimes (NTFS change times) differ from Oriel RS's; the first scan
  after an import stats every file again.
- The build is unsigned: SmartScreen warns on Setup.exe ("More info", then "Run anyway").
