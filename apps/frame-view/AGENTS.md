# Repository Guidelines

## Project Structure & Module Organization
- `src/main.ts` boots the Electron main process.
- `src/main/` contains desktop runtime logic: `services/`, `ipc/`, `db/`, and `menu.ts`.
- `src/preload.ts` defines the renderer bridge API.
- `src/renderer.tsx` and `src/renderer/` hold the React UI (`components/`, `store/`, `utils/`).
- `src/shared/contracts.ts` is the Zod-backed source of truth for shared runtime contracts; `src/shared/types.ts` remains the canonical type import surface.
- `src/main/db/schema.ts` defines the Drizzle media-index schema.
- `docs/` stores product notes and implementation plans; root config files (`forge.config.ts`, `vite.*.config.ts`, `tailwind.config.cjs`, `biome.jsonc`, `knip.jsonc`, `drizzle.config.ts`) define build and maintenance tooling.

## Build, Test, and Development Commands
- `pnpm install`: install dependencies.
- `pnpm run start`: run Electron Forge in dev mode with Vite.
- `pnpm run lint`: run Biome checks for the repo.
- `pnpm run format`: format the repo with Biome.
- `pnpm run knip`: detect unused files, exports, and dependencies.
- `pnpm run db:generate`: generate Drizzle migration files from `src/main/db/schema.ts`.
- `pnpm run test`: run Vitest.
- `pnpm run package`: create a local packaged app build. (ONLY USER MAY RUN THIS)
- `pnpm run make`: generate platform distributables. (ONLY USER MAY RUN THIS)
- `pnpm run publish`: publish artifacts using Forge publishers.

## Coding Style & Naming Conventions
- Language: TypeScript + React (`react-jsx`), 2-space indentation, semicolons enabled.
- Follow `biome.jsonc`; run `pnpm run lint` before opening a PR.
- Use `PascalCase` for React components/classes (`GalleryGrid.tsx`, `ScanService`), `camelCase` for functions, variables, and store methods.
- Keep shared IPC/domain schemas in `src/shared/contracts.ts` and import shared types from `src/shared/types.ts` instead of duplicating interfaces.
- Main/preload IPC boundaries must use serialized `better-result` payloads and shared Zod schemas rather than ad hoc guards or plain thrown/`null` contracts.
- Never use dynamic imports (unless asked to) like `await import(..)`
- Never cast to `any`
- Do not add extra defensive checks or try/catch blocks

## Testing Guidelines
- For every change, include manual verification steps in PRs (example: open folder, run scan, open viewer modal, verify settings persistence).
- When adding tests, prefer locating them in the tests folder.

## Commit & Pull Request Guidelines
- Match current history style: short, imperative, lowercase subjects (example: `add ffmpeg`, `polish pass`).
- Keep commits focused to one logical change.
- PRs should include: concise summary, linked issue/docs, manual test notes, and screenshots/GIFs for UI updates.

## Security & Configuration Tips
- Keep Node/Electron access in main/preload layers; do not expose raw Node APIs directly in renderer components.
- Avoid committing machine-specific paths or sensitive local configuration.

## AI Collaboration Notes
- Record important project context and user implementation preferences in `docs/ai-notes.md` as they are discovered. Make sure to cleanup old notes with outdated information when you can.
