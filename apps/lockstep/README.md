# Lockstep Desktop

Electron desktop client for planning and running archive sync against Pane View.

## Prerequisites

- Install dependencies from the **repo root** (not from `apps/lockstep`):

```bash
pnpm install
```

Lockstep shares the monorepo lockfile. Running `pnpm install` inside `apps/lockstep` is unsupported and can fail supply-chain policy checks or leave dependencies incomplete.

Build workspace packages first:

```bash
pnpm -r --filter './packages/*' build
```

## Development

From the repo root:

```bash
pnpm dev:lockstep
```

Or from this directory after a root install:

```bash
pnpm start
```

If Electron fails to launch, repair the local binary from the repo root:

```bash
pnpm --filter @latch-works/lockstep-app exec electron --version
```

## Troubleshooting

### Blank white window

Usually means renderer dependencies were not installed from the repo root. Run `pnpm install` at the repository root, then restart Lockstep.

### `MINIMUM_RELEASE_AGE_VIOLATION` on install

Use the root lockfile only. If you previously installed inside `apps/lockstep`, remove `apps/lockstep/node_modules` and run `pnpm install` from the repo root.
