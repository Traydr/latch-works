# Plan 064: Oriel on Windows, built, installed and checked

> **Executor instructions**: Written 2026-10-31 at commit `3e0cf587` for a coding agent on the
> owner's Windows 11 x64 machine. Oriel 1.0.0 is the Rust app on GPUI that replaced Electron
> Oriel (plan 063). It builds and packages for Windows from this workspace, but nothing of it has
> ever run on Windows. This plan gets it running well there: built, installed and checked, piece
> by piece. Read these first:
> - [docs/runbooks/oriel-windows.md](../runbooks/oriel-windows.md): what each Windows piece is,
>   and how it was written;
> - [docs/runbooks/oriel.md](../runbooks/oriel.md): the app, its check variables, the sandbox and
>   the fixtures;
> - plan 063's "Phase 8: Windows x64" and "Risks and STOP conditions";
> - [plan 062](062-tidy-on-windows.md), whose checks ran on this machine for Electron Oriel.
>
> These decisions are the owner's and stand: no signing and no updater (063, decision 19);
> Windows is best effort (decision 21); the GPL libmpv build is fine for the owner's own use;
> Electron Oriel is gone, and nothing of its data is migrated.
>
> **Drift check (run first)**: `git diff --stat 3e0cf587..HEAD -- apps/oriel
> docs/runbooks/oriel-windows.md`. A change to a file a step below names may answer or move that
> step.

## Status

- **Status**: TODO
- **Priority**: P2
- **Effort**: L
- **Risk**: MEDIUM. Every Windows path is new and unrun, and Tidy moves files. The sandbox and
  throwaway archives keep that away from the owner's library.
- **Depends on**: 063 (Phase 8 written, merged to `main` in #192)
- **Planned at**: commit `3e0cf587`, 2026-10-31

## Goal

Oriel 1.0.0 installed from its own Setup.exe on the owner's Windows machine, playing 1080p video
at 60 fps, and doing on Windows what it does on the Mac: View, Tidy and Sync, the single
instance, the title bar, the installer and the exe. Each check below ends as works, fails (with
its output), or fixed (with the commit).

## State

Written from the Mac and compile-checked only: the workspace passes `cargo clippy` for
`x86_64-pc-windows-gnullvm` (llvm-mingw), a debug exe links, and `package windows --stage-only`
stages the install folder. Nothing has been built with MSVC, rendered, played or installed. The
runbook's "What was done from the Mac" lists each piece and where its code is; its "To check on
Windows" is the same list as the phases below.

`apps/oriel/scripts/install-windows.ps1` takes the machine from nothing to an installed Oriel. It
was written without PowerShell to run it, so expect step 1 to find mistakes in it.

The machine has Electron Oriel installed through Velopack (pack id `Oriel`, in
`%LOCALAPPDATA%\Oriel`), with its data in `%USERPROFILE%\.latch-works\oriel`, and the older apps'
data in `frame-view`, `glazier` and `lockstep` beside it. The script uninstalls Electron Oriel,
moves its `oriel` folder aside to `oriel-electron-<date>`, and leaves the other three alone.

## Ground rules

- **Branch and commits.** Work on a branch made from `main`, such as `agent/064-oriel-windows`. Commit each fix on its own, with a short
  imperative subject in the branch's style, such as `fix(oriel): load libavif beside the exe on
  Windows`. Push, or open a PR, only when the owner asks.
- **Throwaway data only.** Every check runs with `ORIEL_DATA_DIR` set to a scratch folder, such as
  `$env:TEMP\oriel-check`, which also keeps Tidy in its sandbox: it takes only roots under that
  folder's `sandbox\` or the temp folder. Never change a file outside a throwaway test archive
  when testing Tidy. The owner's library syncs through Tresorit, so Tidy on this machine never
  opens it; the owner points the installed app at it, if at all.
- **Numbers, not content.** The library is adult content. Reports, screenshots and uploads carry
  counts, sizes and timings, never its frames, thumbnails or file names. Never upload the owner's
  media anywhere. Screenshots of test archives are fine.
- **Rust only.** Fixes and new tooling are Rust, in the Cargo workspace. The install script is the
  one PowerShell file; fix it there rather than adding another. Node runs only the existing
  fixture script and conformance vectors.
- **The STOP condition stands.** If video cannot reach 60 fps at 1080p (phase 2), stop and report
  before going further.

## Step 1: run the install script

From a clone of the repository, on your branch from `main`:

```powershell
powershell -ExecutionPolicy Bypass -File apps\oriel\scripts\install-windows.ps1
```

`pwsh` works the same way. The script's usage block lists its steps and switches
(`-SkipPrerequisites`, `-BuildOnly`, `-NoLaunch`, `-Clean`); its logs go to
`%TEMP%\oriel-install`. When a step fails it names the step and exits non-zero. Fix the cause, in
the script or the Rust, commit it, and run the script again: it skips what is done.

What it does that has never been run, so most likely to need a fix:

- **Elevation.** The Build Tools and the .NET SDK install machine-wide, so the script starts
  `winget` for them with `Start-Process -Verb RunAs`. That `winget` is an App Execution Alias;
  check that it elevates, and that the exit code comes back.
- **Visual Studio.** It installs `Microsoft.VisualStudio.2022.BuildTools` with the VCTools workload,
  `VC.Tools.x86.x64` and `Windows11SDK.26100`. A Visual Studio already present without them gets a
  `modify` through its own installer, which may return before it finishes; the script then says
  to run it again.
- **The pinned toolchain.** It installs `1.99.1-x86_64-pc-windows-msvc` (from
  `rust-toolchain.toml`) with rustfmt and clippy, and refuses a rustup whose default host is not
  MSVC.
- **The C build.** rusqlite's SQLite and libwebp-sys's libwebp have never been compiled against
  MSVC's headers; GPUI's release build compiles its shaders with `fxc.exe`, which the script
  names in `GPUI_FXC_PATH` (the newest in `Windows Kits\10\bin`); `embed-resource` runs `rc.exe`.
- **Unpacking.** The xtask unpacks with Windows' own `tar.exe` (bsdtar), which must read the
  libmpv `.7z` and the ffmpeg `.zip`. If this build's bsdtar cannot read 7z, unpack it in Rust
  rather than adding a tool.
- **Long paths.** If a build step fails on a path that is too long, try a short
  `CARGO_TARGET_DIR` (such as `C:\ot`) first. Turning on `LongPathsEnabled` changes the
  machine's registry: ask the owner.
- **Electron Oriel.** The script uninstalls it with `Update.exe uninstall --silent`, Velopack's own
  verb, then moves the data folder aside only if it holds `Local State` or `Cache` and no `shell\`.
  Check that Electron Oriel's Start menu entry and its entry in Settings › Apps are gone, and that
  `oriel-electron-<date>` holds what `oriel` held.
- **Setup.exe.** `--silent` installs without dialogs and does not start the app, so the script
  starts `%LOCALAPPDATA%\Oriel\current\oriel.exe` itself.

**Done when** one run on this machine ends with Oriel open and the welcome showing, a second run
skips each prerequisite and the install ("is this build already"), and `-Clean` removes the build
folder, printing its size.

## Phase 1: the MSVC build

1. In `apps\oriel`: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
   and `cargo test --workspace`, as `pnpm oriel:check` runs them. The tests that load libvips
   take it from `node_modules` (`pnpm install` at the root) or `ORIEL_LIBVIPS`. Symlink tests need
   Developer Mode; if it is off, record which tests skip or fail for that reason alone.
2. The GPUI tests that port the e2e cases are part of `cargo test`; record any that fail on
   Windows only.
3. The conformance vectors and Tidy's differential runs, as the runbook's "Keeping the two
   implementations in step" describes.

**Done when** each passes, or each failure is written down with its output and either fixed or
named as a Windows finding.

## Phase 2: the video gate

Plan 063 sets it: **STOP and report if video cannot reach 60 fps at 1080p** on this machine.
Video plays through libmpv's software renderer (`hwdec=d3d11va-copy`), each frame converted to
BGRA and drawn as an image, since GPUI's `surface()` is macOS only.

1. Make 30-second 1080p60 clips into `%TEMP%\oriel-video` with the pinned ffmpeg
   (`apps\oriel\.media-tools\win32-x64`): H.264 (`libx264`), HEVC (`libx265`) and AV1
   (`libsvtav1` at CRF 35, what Shrink writes), from `testsrc2` with noise as the fixture script
   makes them. Add one 4K60 H.264 clip.
2. With `ORIEL_LIBMPV` set to the staged
   `target\release\package\windows\Oriel\libmpv-2.dll`:
   `cargo run --release -p oriel-media --example mpv_spike -- single <clip>` for each. Its steady
   line gives the pictures shown against those expected and mpv's dropped frames. Then
   `tiles` with four 1080p clips, as Duplicates plays them.
3. The installed app, with `ORIEL_DATA_DIR` scratch and `ORIEL_OPEN=$env:TEMP\oriel-video`: open
   each clip in the viewer and watch for stutter. Task Manager gives CPU and GPU use.

**Done when** single 1080p60 playback shows at least 98% of the expected pictures with no
steady drops, for each codec, and the report has the 4K and tiles numbers beside them. If 1080p60
falls short, **STOP**: report the numbers, the CPU and GPU use and the decoder mpv chose, and wait
for the owner. The next step would be mpv's D3D11 render API into a shared texture, which needs a
GPUI surface on Windows; that is a decision, not a fix.

## Phase 3: stills and AVIF

1. **Stills in View.** A test folder of JPEG (with EXIF orientations), PNG, WebP, GIF, AVIF and HEIC
   (the fixture's `stills\` covers most): thumbnails fill, the viewer shows each the right way up.
   libvips decodes them all, with its own libheif and aom for AVIF and HEIC.
2. **Fingerprints** equal glazier-core's (the conformance vectors, libvips 8.18).
3. **Convert to AVIF.** In a sandboxed Tidy, Convert loads the staged `libavif\libavif-16.dll`
   (Settings or the log names it), a still converts, and the result opens in Photos. Rename
   `libavif\` away and Convert says no libavif was found.

**Done when** each still type shows in View and Tidy, fingerprints match, and Convert writes an
AVIF Photos opens.

## Phase 4: Tidy on Windows

Plan 062's checks, redone against the Rust engine, each on a throwaway archive in the sandbox.
The runbook's "To check on Windows" has the detail for each.

- [ ] **Files held open.** A video playing in Duplicates, a file View has open, one Defender is
      scanning: the step fails with "Another program has … open", nothing is half moved, and Undo
      runs again once the file is closed.
- [ ] **Replacing in place.** Shrink's MP4 to MP4, and Undo with the output open elsewhere.
- [ ] **Drives.** An archive on `D:` with the data on `C:` holds in `D:\.latch-works\oriel\holding`
      by rename (this one needs a run without `ORIEL_DATA_DIR`, on a throwaway folder on `D:`);
      a whole drive as the root holds by copy. Undo both. If the machine has one drive, a VHDX
      mounted as `D:` stands in.
- [ ] **Long paths.** A file past 260 characters through the scan, fingerprints, thumbnails,
      ffprobe and Shrink.
- [ ] **Names.** Japanese and other non-ASCII names through ffmpeg's arguments and libvips.
- [ ] **Explorer's files.** `desktop.ini` in a hidden, system, read-only folder, and `Thumbs.db`.
- [ ] **Hard links.** `mklink /H` a picture: Duplicates frees nothing for it.
- [ ] **The Recycle Bin.** Empty Holding puts each batch in the Recycle Bin, restorable from there;
      a batch on a drive with the Recycle Bin off fails with a message and stays in holding.
- [ ] **NTFS change times against Node.** After a scan, `fs.statSync(f).ctimeMs` in Node equals
      the catalog's `ctime_ms` (whole milliseconds); `attrib +r` alone moves it; a second scan
      hashes nothing again.

**Done when** each box has a result.

## Phase 5: the shell

- [ ] **One instance and hand-over.** A second launch with a folder (`oriel.exe <folder>`, or
      Explorer's Open with) opens it in the first window; without one it brings the first to the
      front; a run with another `ORIEL_DATA_DIR` starts beside it.
- [ ] **The title bar and app menu.** Dragging, double-click to maximize, Snap Layouts on hovering
      the maximize button, the caption buttons, and the menus by mouse and by Alt. File ends with
      Settings… and Exit; Window has Minimize and Close; Help has About.
- [ ] **Taskbar progress.** The taskbar button shows progress during a push (to the local compose
      stack only) and during a Tidy change, and clears after.
- [ ] **Logoff while working.** Sign out during a push: Windows' screen names Oriel with its reason,
      the app quits when the push ends and the sign-out goes on; "Sign out anyway" quits at once.

**Done when** each box has a result.

## Phase 6: the installer and the exe

- [ ] **Install.** Setup.exe installs silently to `%LOCALAPPDATA%\Oriel\current` with a Start menu
      entry, Oriel starts, and About lists the licences.
- [ ] **Upgrade.** Change the workspace version to `1.0.1` locally (not committed), package, and run
      the new Setup.exe over the installed one: it replaces it, the data folder is untouched, and
      About says 1.0.1. Put the version back.
- [ ] **Uninstall.** From Settings › Apps: the install folder and Start menu entry go, and
      `%USERPROFILE%\.latch-works\oriel` stays.
- [ ] **The exe's icon.** Explorer shows Oriel's icon on `oriel.exe` and, in Properties › Details,
      "Oriel" and the version; the taskbar and the window show it too.
- [ ] **The C runtime.** The MSVC build links `vcruntime140.dll`, which this machine has through
      the Build Tools and a clean one may not. Check with `dumpbin /dependents oriel.exe`, then
      propose to the owner either a static CRT or vpk's VC++ redistributable dependency; don't
      choose alone.

**Done when** each box has a result, and the C runtime question is in the report.

## Reporting back

Write the results into this plan, under a "Results" section dated as plan 062's is, and tick the
runbook's "To check on Windows" list. The owner wants:

- the machine (CPU, memory, GPU, Windows build) and what step 1 needed fixing;
- the video table: each clip's codec, pictures shown against expected, drops, CPU and GPU use;
- each phase item's result: works, fails (with output), or fixed (with the commit);
- test counts from phase 1, and the Windows-only failures;
- what is left for the owner to decide, starting with the C runtime.

Update this plan's row in [the index](README.md) in the same commit as the results.

## Not in scope

- Signing, an updater, ARM64 and Windows 10.
- The D3D11 video path, unless the owner asks after the gate.
- Electron Oriel's data: the owner needs none of it migrated.
