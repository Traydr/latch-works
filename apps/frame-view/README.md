# Frame View

> Cross-platform desktop image and video viewer — the local gallery north star for [Pane View](../pane-view).

Frame View is part of the [Latch Works](../../README.md) monorepo. It browses folders on disk with a keyboard-first gallery, fullscreen viewer, comic mode, and a SQLite media index. Use it to organize and preview a local archive before syncing to Pane View via [Lockstep](../../apps/lockstep-cli).

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Features

- Mixed image + video gallery with virtualized rendering for large folders
- Fullscreen viewer modal with playback controls for video
- Comic mode — image folders grouped and read as comics
- Folder scanning with optional recursive mode and persistent settings
- Sidebar tree + folder overlay browser for fast navigation
- Thumbnail cache and SQLite media index maintenance tools
- Native desktop menu integration and keyboard-first navigation
- Sort modes: name, date, random

## Tech stack

| Layer | Choices |
| --- | --- |
| Desktop | Electron Forge + Vite |
| UI | React 19, TypeScript, Tailwind CSS 4 |
| State | Zustand |
| Contracts | Zod + [better-result](https://github.com/better-auth/better-result) IPC boundaries |
| Database | SQLite + Drizzle ORM |
| Media | `sharp`, `ffmpeg-static`, `ffprobe-static` |
| Tooling | Biome, Knip, Vitest |

## Getting started

### Prerequisites

- pnpm 11 (install from repo root: `pnpm install`)
- Node.js + npm on `PATH` (required by Electron Forge packaging)

### Run in development

From the **repo root**:

```bash
pnpm --filter @latch-works/frame-view start
```

Or from this directory:

```bash
pnpm start
```

If Electron fails to launch with a missing `Electron Framework.framework` error, repair the local binary install:

```bash
pnpm run ensure-electron
```

`pnpm start` runs this check automatically before launching Forge.

### macOS packaging

Build on a Mac with icon assets in `media/` (`frame-view-icon.icns`, `.png`, `.ico`):

```bash
pnpm --filter @latch-works/frame-view package   # .app in out/
pnpm --filter @latch-works/frame-view make      # ZIP + DMG in out/make/
```

Unsigned builds require Gatekeeper override the first time (right-click the app → Open). To distribute outside your machine, sign and notarize the app with an Apple Developer ID certificate.

## Scripts

| Script | Description |
| --- | --- |
| `pnpm start` | Electron Forge dev mode |
| `pnpm lint` | Biome checks |
| `pnpm format` | Format with Biome |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Vitest |
| `pnpm knip` | Unused files, exports, and dependencies |
| `pnpm db:generate` | Generate Drizzle migrations from schema |
| `pnpm package` | Package app output |
| `pnpm make` | Build distributables (installers) |
| `pnpm publish` | Publish via Forge publishers |

## Keyboard shortcuts

### App / menu

| Key | Action |
| --- | --- |
| `Ctrl/Cmd + O` | Open folder dialog |
| `F5` (Win/Linux) or `Cmd/Ctrl + R` (macOS) | Refresh current folder |
| `Ctrl/Cmd + ,` | Open preferences |

### Gallery

| Key | Action |
| --- | --- |
| `←` / `→` or `A` / `D` | Previous / next item |
| `↑` / `↓` or `W` / `S` | Move one row |
| `Enter` or `F` | Open selected item in viewer |
| `Escape` (sort menu open) | Close sort menu |

### Viewer

| Key | Action |
| --- | --- |
| `Escape` | Close viewer |
| `←` or `Q` | Previous item |
| `→` or `E` | Next item |
| `Space` or `2` (video) | Play / pause |
| `1` (video) | Seek back 5 seconds |
| `3` (video) | Seek forward 5 seconds |
| Hold `4` (video) | Temporary `2×` speed until release |

## Project structure

```text
src/
├── main.ts              # Electron main process bootstrap
├── main/                # Services, IPC, database, menu
├── preload.ts           # Secure renderer bridge API
├── renderer.tsx
├── renderer/            # React UI, components, state, utils
├── shared/
│   ├── contracts.ts     # Zod schemas and IPC contracts
│   └── types.ts         # Shared type surface
└── main/db/schema.ts    # Drizzle SQLite media index schema
docs/                    # Product notes and planning docs
```

## Contract notes

- Main-process IPC handlers return serialized `better-result` payloads.
- `src/preload.ts` deserializes those payloads back into `Result` values.
- Renderer call sites explicitly unwrap success/error results instead of relying on `null` sentinels or thrown preload errors.

## Manual verification

Automated checks: `pnpm lint`, `pnpm test`, `pnpm knip`.

After changes, verify manually by:

1. Opening a folder and scanning media
2. Navigating with gallery/viewer hotkeys
3. Opening settings and changing preferences
4. Confirming cache/index actions complete successfully

## Related

- [Pane View](../pane-view/README.md) — web viewer targeting feature parity
- [Lockstep](../../apps/lockstep-cli/README.md) — sync local archive to Pane View
- [Root README](../../README.md) — monorepo overview

## License

MIT — see [LICENSE](LICENSE).
