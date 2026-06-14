# Electron macOS signing

Latch Works ships two Electron desktop apps:

- Frame View (`apps/frame-view`)
- Lockstep (`apps/lockstep`)

Both apps use Electron Forge. Forge is the official Electron toolbox and delegates macOS
packaging/signing to `@electron/packager`, `@electron/osx-sign`, and `@electron/notarize`.
This is different from `electron-builder`, which is a more opinionated all-in-one release system
with more signing and update behavior built in.

## Why signing matters

macOS uses the app bundle id and code signature as part of the app identity. For Electron apps this
matters in two separate ways:

1. Keychain access: Electron `safeStorage` stores encryption keys in macOS Keychain. If the packaged
   app identity changes or the app is invalidly signed, a token can be written in one run and become
   unreadable in the next run.
2. Hardened runtime: Electron apps load nested helper apps and `Electron Framework.framework`. When
   a local ad-hoc build uses hardened runtime without the right entitlements, dyld can reject the
   framework with an error like:

```text
mapped file (non-platform) have different Team IDs
```

Lockstep hit both paths: first the sync token was stored but unreadable, then the locally signed app
failed at launch until the helper-process entitlements were applied.

## Release builds

The proper macOS release path is:

1. Build on macOS.
2. Sign the full app with one Apple Developer ID Application identity.
3. Notarize the app with Apple.
4. Verify the generated `.app`, DMG, and ZIP before publishing.

The current Forge configs accept these environment variables:

- `LOCKSTEP_MACOS_SIGN_IDENTITY`
- `FRAME_VIEW_MACOS_SIGN_IDENTITY`

Use the exact Developer ID Application identity name reported by:

```bash
security find-identity -v -p codesigning
```

Example:

```bash
LOCKSTEP_MACOS_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" pnpm --filter @latch-works/lockstep-app make
FRAME_VIEW_MACOS_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" pnpm --filter @latch-works/frame-view make
```

Release notarization is not wired yet. Until it is, these builds are signed but not fully prepared
for frictionless distribution to other Macs.

## Local ad-hoc builds

If the app-specific signing identity env var is unset, the Forge configs use ad-hoc signing with
identity `-`. This is only for local same-machine testing.

For local ad-hoc builds, every nested `.app` bundle gets these entitlements:

```text
com.apple.security.cs.allow-jit
com.apple.security.cs.allow-unsigned-executable-memory
com.apple.security.cs.disable-library-validation
```

The last entitlement is the important workaround for the dyld Team ID crash when hardened runtime is
enabled but the app does not have a real Apple Team ID.

Do not treat ad-hoc signing as a replacement for Developer ID signing and notarization. It is useful
for `pnpm make` artifacts that are installed and tested on the same development machine.

## Verification commands

After `pnpm make`, verify the app bundle before installing the DMG:

```bash
codesign --verify --deep --strict --verbose=2 apps/lockstep/out/Lockstep-darwin-arm64/Lockstep.app
codesign -dv apps/lockstep/out/Lockstep-darwin-arm64/Lockstep.app
codesign --display --entitlements :- apps/lockstep/out/Lockstep-darwin-arm64/Lockstep.app
codesign --display --entitlements :- "apps/lockstep/out/Lockstep-darwin-arm64/Lockstep.app/Contents/Frameworks/Lockstep Helper.app"
```

```bash
codesign --verify --deep --strict --verbose=2 "apps/frame-view/out/Frame View-darwin-arm64/Frame View.app"
codesign -dv "apps/frame-view/out/Frame View-darwin-arm64/Frame View.app"
codesign --display --entitlements :- "apps/frame-view/out/Frame View-darwin-arm64/Frame View.app"
codesign --display --entitlements :- "apps/frame-view/out/Frame View-darwin-arm64/Frame View.app/Contents/Frameworks/Frame View Helper.app"
```

Expected local-build signals:

- `codesign --verify` reports `valid on disk`.
- Lockstep displays `Identifier=dev.traydr.latchworks.lockstep`.
- Frame View displays `Identifier=dev.traydr.latchworks.frameview`.
- Top-level and helper `.app` entitlements include `disable-library-validation`.

Frame View also stages runtime packages (`ffmpeg-static`, `ffprobe-static`, and `sharp`) into
`Contents/Resources`. Those package roots must be copied as real files, not pnpm symlinks. Absolute
symlinks back into the workspace make `codesign --verify --deep --strict` fail with messages such as
`invalid destination for symbolic link in bundle`.

## Forge versus electron-builder

Electron Forge and electron-builder overlap, but they optimize for different workflows.

Forge is modular. It exposes the underlying packaging, signing, maker, Vite, and fuse pieces. This is
why Latch Works needs explicit `appBundleId`, `osxSign`, and local ad-hoc entitlement config.

electron-builder is a more integrated release system. It tends to infer more signing behavior, emits
auto-update metadata, and documents the exact ad-hoc hardened-runtime Team ID failure we saw. T3 Code
uses electron-builder with `appId: "com.t3tools.t3code"` and enables macOS signing in CI only when
the Apple signing/notarization secrets are available.

Latch Works does not need to switch tools for this issue. Electron Forge is fine as long as the app
identity and signing rules are explicit.

## References

- [Electron Forge macOS signing](https://www.electronforge.io/guides/code-signing/code-signing-macos)
- [Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)
- [electron-builder macOS signing](https://www.electron.build/code-signing-mac.html)
- [T3 Code desktop build script](https://raw.githubusercontent.com/pingdotgg/t3code/main/scripts/build-desktop-artifact.ts)
- [T3 Code release workflow](https://raw.githubusercontent.com/pingdotgg/t3code/main/.github/workflows/release.yml)
