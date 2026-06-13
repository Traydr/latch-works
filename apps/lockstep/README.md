# Lockstep Desktop

Electron desktop client for planning and running archive sync against Pane View.

## Prerequisites

Install and build from the **repo root**:

```bash
pnpm install
pnpm -r --filter './packages/*' build
```

## Development

Preferred (repo root):

```bash
pnpm dev:lockstep
```

Equivalent:

```bash
pnpm --filter @latch-works/lockstep-app start
```

You can also run `pnpm start` from `apps/lockstep` after a root install. Electron Forge may create a local `apps/lockstep/pnpm-lock.yaml` on first launch; that file is gitignored. Do not commit it.

`apps/lockstep/pnpm-workspace.yaml` lists only Lockstep and its workspace package dependencies (`lockstep-core`, `media-index`, `media-domain`) so Forge can use a hoisted install without pulling the entire monorepo.

## Packaging on macOS

Build the installable app from `apps/lockstep`:

```bash
pnpm make
```

Lockstep stores desktop sync tokens with Electron `safeStorage`, which uses macOS Keychain.
Packaged macOS builds must have a stable bundle id and a valid code signature, or Keychain can
allow the app to store the token but refuse to unlock it on the next launch.

Forge sets `CFBundleIdentifier` to `dev.traydr.latchworks.lockstep` and signs macOS packages by
default. If `LOCKSTEP_MACOS_SIGN_IDENTITY` is set, that identity is used. If it is unset, local
builds are signed ad-hoc with `identity: "-"`, plus local-only Electron helper entitlements that
disable hardened-runtime library validation. This is enough for same-machine testing but is not
notarized for distribution.

To see available signing identities:

```bash
security find-identity -v -p codesigning
```

For distributable builds, use an Apple Developer ID Application certificate:

```bash
LOCKSTEP_MACOS_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" pnpm make
```

After changing from the earlier unsigned package to a signed package, re-enter the sync token once in
Lockstep. Tokens saved by the old invalid signature may remain unreadable, but newly saved tokens
should survive restarts.

Verify a packaged app before using the DMG:

```bash
codesign --verify --deep --strict --verbose=2 out/Lockstep-darwin-arm64/Lockstep.app
codesign -dv out/Lockstep-darwin-arm64/Lockstep.app
```

The displayed identifier should be `dev.traydr.latchworks.lockstep`, and verification should report
that the app is valid on disk.

If the app fails at launch with `Library not loaded: @rpath/Electron Framework.framework/Electron
Framework` and `mapped file (non-platform) have different Team IDs`, the package is missing the
local ad-hoc helper entitlements or was signed with mixed identities. Rebuild with the current Forge
config, or use one Developer ID Application identity for the full package.

## Troubleshooting

### `WORKSPACE_PKG_NOT_FOUND` for `@latch-works/lockstep-core`

You ran `pnpm install` or `pnpm start` in a way that treated `apps/lockstep` as an isolated workspace. Fix:

```bash
cd /path/to/latch-works
rm -rf apps/lockstep/node_modules
pnpm install
pnpm -r --filter './packages/*' build
pnpm dev:lockstep
```

### Blank white window

Usually means renderer dependencies were not installed from the repo root. Run `pnpm install` at the repository root, then restart Lockstep.

### `MINIMUM_RELEASE_AGE_VIOLATION` on install

Use the root lockfile only. Remove any `apps/lockstep/pnpm-lock.yaml` if it reappears locally, then run `pnpm install` from the repo root.

### `ERR_PNPM_IGNORED_BUILDS` (fs-xattr / macos-alias)

`@electron-forge/maker-dmg` depends on native packages `fs-xattr` and `macos-alias`. Their build scripts are approved in `apps/lockstep/pnpm-workspace.yaml` and versions are pinned via workspace `overrides`. Run `pnpm install` from the repo root, or `pnpm install` in `apps/lockstep` if Forge triggers a nested install.

### `Electron failed to install correctly`

Electron's postinstall sometimes does not write `node_modules/electron/path.txt` after a hoisted or nested install. Lockstep runs `scripts/ensure-electron.mjs` on `postinstall` and before `start` to repair this automatically. If it still fails:

```bash
cd apps/lockstep
rm -rf node_modules/electron
pnpm install
pnpm start
```
