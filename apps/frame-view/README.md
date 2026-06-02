# frame-view

Cross-platform desktop image and video viewer built with Electron, Vite, React, and TypeScript.

## Features

- Mixed image + video gallery with virtualized rendering for large folders
- Fullscreen-style viewer modal with playback controls for video
- Folder scanning with optional recursive mode and persistent settings
- Sidebar tree + folder overlay browser for fast folder navigation
- Thumbnail cache and SQLite media index maintenance tools
- Native desktop menu integration and keyboard-first navigation

## Tech Stack

- Electron Forge + Vite
- React 18 + TypeScript
- Tailwind CSS
- Zod shared contracts
- better-result result-based IPC boundaries
- Drizzle schema management for the SQLite media index
- Biome + Knip for maintenance tooling
- Pnpm package manager
- ffmpeg / ffprobe sidecar tooling for video metadata and thumbnails

## Getting Started

### Prerequisites

- Pnpm installed
- Node.js + npm available in PATH (required by Electron Forge packaging)

### Install dependencies

```bash
pnpm install
```

### Run in development

```bash
pnpm run start
```

## Scripts

- `pnpm run start`: run Electron Forge in dev mode
- `pnpm run lint`: run Biome checks
- `pnpm run format`: format the repo with Biome
- `pnpm run knip`: detect unused files, exports, and dependencies
- `pnpm run db:generate`: generate Drizzle migrations from the media-index schema
- `pnpm run test`: run Vitest
- `pnpm run package`: create packaged app output
- `pnpm run make`: generate distributables (installer artifacts)
- `pnpm run publish`: publish distributables via Forge publishers

## Keyboard Shortcuts

### App / Menu

- `Ctrl/Cmd + O`: open folder dialog
- `F5` (Windows/Linux) or `Cmd/Ctrl + R` (macOS): refresh current folder
- `Ctrl/Cmd + ,`: open preferences

### Gallery

- `Arrow Left` / `Arrow Right`: move selection previous/next
- `Arrow Up` / `Arrow Down`: move selection by one row
- `A` / `D`: move selection previous/next (one-hand alternative)
- `W` / `S`: move selection by one row (one-hand alternative)
- `Enter` or `F`: open selected item in viewer
- `Escape` (while sort menu is open): close sort menu

### Viewer

- `Escape`: close viewer
- `Arrow Left` or `Q`: previous item
- `Arrow Right` or `E`: next item
- `Space` or `2` (video): play/pause
- `1` (video): seek back 5 seconds
- `3` (video): seek forward 5 seconds
- `Hold 4` (video): temporarily set viewer speed to `2x` until release

## Project Structure

- `src/main.ts`: Electron main process bootstrap
- `src/main/`: main-process services, IPC handlers, database, menu
- `src/preload.ts`: secure renderer bridge API
- `src/renderer.tsx` + `src/renderer/`: React UI, components, state, utils
- `src/shared/contracts.ts`: shared Zod schemas and serialized IPC contract definitions
- `src/shared/types.ts`: shared type surface re-exported from the contracts
- `src/main/db/schema.ts`: Drizzle schema for the media index
- `docs/`: product notes, planning docs, and AI collaboration notes

## Contract Notes

- Main-process IPC handlers return serialized `better-result` payloads.
- `src/preload.ts` deserializes those payloads back into `Result` values.
- Renderer call sites explicitly unwrap success/error results instead of relying on `null` sentinels or thrown preload errors.

## Open Source

- License: `MIT` (see `LICENSE`)

## Manual Verification

Automated checks are available via `pnpm run lint`, `pnpm run test`, and `pnpm run knip`.

After changes, verify manually by:

- opening a folder and scanning media
- navigating with gallery/viewer hotkeys
- opening settings and changing preferences
- confirming cache/index actions complete successfully
