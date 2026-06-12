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
