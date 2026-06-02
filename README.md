# Latch Works

Latch Works is a private media viewer ecosystem for collecting, syncing, and browsing a personal archive across desktop and web.

The first implementation in this repo focuses on:

1. **Pane View** - a TanStack Start web viewer prototype.
2. **Lockstep** - a local archive scanning and sync-planning CLI.
3. **Shared packages** - media type detection, path-preserving archive modeling, storage key conventions, and scan planning.

The local archive remains the source of truth. Pane View is private, read-only, online-only, and designed around explicit sync.

## Workspace

```text
apps/
  pane-view/
packages/
  media-domain/
  media-index/
  media-storage/
tools/
  lockstep/
docs/
  decisions/
  runbooks/
```

Frame View and Gather Box are intentionally not copied into this repo yet. The next consolidation step is to import those existing working trees under `apps/frame-view` and `apps/gather-box`, then extract shared code incrementally.

## Commands

```powershell
pnpm install
pnpm check
pnpm dev:pane
pnpm lockstep -- plan --source "T:\cloud-desktop\media"
```

`lockstep plan` only reads the source tree and prints a sync plan. It does not change the archive.
