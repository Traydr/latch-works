# Oriel Runbook

Oriel is the desktop app: View (Frame View), Tidy (Glazier) and Sync (Lockstep) as three modes of
one window. The plan that made it is [059](../plans/059-one-desktop-app.md). Its code is in
`apps/oriel`; each mode's own runbook covers using it ([Tidy](glazier.md), [Sync](lockstep.md)).

Oriel is built from source and is not signed with a Developer ID or a Windows certificate, so
each OS asks once before the first start (see [Open an unsigned build](#open-an-unsigned-build)).

## Build it

### Prerequisites

| | macOS (Apple silicon) | Windows (x64) |
| --- | --- | --- |
| Node | 24, as `package.json` pins | 24 |
| pnpm | 12 (`corepack enable`) | 12 |
| Platform tools | Xcode, or its command-line tools (`xcode-select --install`) | The .NET SDK 9, then `dotnet tool install -g vpk --version 1.3.39-g8d2844f` |

Build on the OS you build for. Forge stages the host's native binaries (sharp, ffmpeg and ffprobe),
so a Windows build made on a Mac would carry Mac binaries. `vpk` is pinned to the `velopack`
package the app runs; change both together (`VPK_VERSION` in `apps/oriel/forge.config.ts`).

With Xcode 26 or later on macOS 26 or later, the build also compiles the Icon Composer icon
(`media/oriel.icon`, with light, dark and tinted looks); otherwise the app keeps the `.icns`.

### One command

```sh
pnpm install
pnpm make:oriel
```

| OS | What it makes | Where |
| --- | --- | --- |
| macOS | `Oriel-<version>-arm64.dmg`, and a ZIP of the app | `apps/oriel/out/make/dmg/arm64/`, `apps/oriel/out/make/zip/darwin/arm64/` |
| Windows | `Oriel-win-Setup.exe` (the installer, with the brand splash), `Oriel-win.msi` (per user or for the machine) and a portable package | `apps/oriel/out/make/velopack/` |

`pnpm --filter @latch-works/oriel package` builds only the app, into
`apps/oriel/out/Oriel-<platform>-<arch>`. `ORIEL_MACOS_SIGN_IDENTITY` names a signing identity;
without it the Mac build is signed ad hoc ([electron-macos-signing.md](../electron-macos-signing.md)).

The installer artwork (the DMG background, Setup's splash, the MSI's bitmaps) and the icons are
generated from SVG masters in `apps/oriel/installer` and `apps/oriel/media` by `pnpm icons`; see
[icons.md](../design/icons.md).

The [Oriel build](../../.github/workflows/oriel-build.yml) workflow makes both as workflow
artifacts, but only when started by hand (Actions › Oriel build › Run workflow); pull requests run
just the Check workflow. On Windows it also installs Setup.exe silently and checks that Oriel
starts. It publishes no release.

## Open an unsigned build

**macOS.** Open the DMG and drag Oriel onto Applications. A DMG made on this Mac opens without a
prompt. One carried to another Mac is quarantined: macOS says it cannot check Oriel for malicious
software. Either clear the quarantine once,

```sh
xattr -dr com.apple.quarantine /Applications/Oriel.app
```

or try to open it, then choose **Open Anyway** in System Settings › Privacy & Security. Started
from the disk image or Downloads, Oriel offers to move itself to Applications.

**Windows.** Run `Oriel-win-Setup.exe`. SmartScreen warns about an unknown publisher: choose
**More info**, then **Run anyway**. Setup installs for the current user into
`%LocalAppData%\Oriel` and adds Start-menu and desktop shortcuts; the MSI can install for every
user instead. Uninstall from Settings › Apps.

## First start

1. Oriel brings over what Frame View, Glazier and Lockstep left: their folders, catalogs,
   settings, the window's size and the saved sync tokens ([Phase 5 of the
   plan](../plans/059-one-desktop-app.md)), and offers to remove the old apps. File › Import from
   the Old Apps… runs it again.
2. A short welcome says what came over. When no folder did, it asks for one archive folder: View
   opens it, and Tidy and Sync take it if asked (Sync with a Pane View address and token). It
   lands in View, scanning. The welcome shows once; `~/.latch-works/oriel/welcomed` records it.

Under `--user-data-dir` (the e2e suite) neither the removal offer, the move to Applications nor
the welcome shows; `ORIEL_WELCOME=1` brings the welcome back for a test.

Keep the old apps closed while Oriel runs. Oriel checks for them when it starts and when Tidy's
engine starts, and Tidy refuses to start beside the old Glazier, since two engines must never
change one catalog; it does not watch for an old app opened later.

## Where its data lives

Oriel's own state is in `~/.latch-works/oriel`: Chromium's storage (the theme, the mode last
shown, each mode's view preferences), `window-state.json`, `migration.json` and `welcomed`. Each
mode keeps the folder its standalone app used beside it: `frame-view`, `glazier` and `lockstep`
(see [Local data](../ARCHITECTURE.md#local-data)).
