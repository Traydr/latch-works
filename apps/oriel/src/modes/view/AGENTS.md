# View mode guidelines

View is Frame View, the local viewer, as one of Oriel's modes (plan 059). The repository's root
`AGENTS.md` and `CLAUDE.md` apply; these notes are what View's code adds on top.

## Layout

- `main/start.ts` starts the mode: settings, the catalog worker, the scan queue, IPC and the
  `frameview-media` protocol. Oriel's `src/main.ts` calls it and owns the window.
- `main/` holds the rest of the desktop runtime: `services/`, `ipc/`, `db/`, `catalog/`,
  `thumbnail/`.
- `preload/frameViewApi.ts` builds the `window.frameView` bridge, which Oriel's preload exposes.
- `renderer/` is the React UI (`components/`, `store/`, `utils/`); `renderer/App.tsx` exports
  `ViewMode`, which the shell mounts.
- `shared/contracts.ts` is the zod source of truth for runtime contracts, and `shared/types.ts`
  the type import surface. `shared/ipcContracts.ts` names every channel; they all start `frame:`.
- `main/db/schema.ts` defines the Drizzle schema of the media index.
- Product notes and old plans live in `docs/frame-view/`.

## Code rules

- Main and preload IPC use serialized `better-result` payloads and the shared zod schemas, not
  ad hoc guards or thrown errors and `null`.
- No dynamic imports (`await import(…)`) unless asked, and no casts to `any`.
- Do not add extra defensive checks or try/catch blocks.
- Keep Node and Electron access in main and preload; the renderer never sees raw Node APIs.
- Oriel keeps hidden modes mounted. A listener View puts on the whole window (keys, drops)
  attaches only while `useModeActive()` is true, and the viewer and comic reader are modal only
  then.

## Testing

Tests live in `apps/oriel/tests/view`. Run `pnpm --filter @latch-works/oriel test`, and the e2e
suite with `pnpm e2e:frame`. Agents may package and make Oriel (`pnpm --filter
@latch-works/oriel package` or `make`), which the owner allowed in plan 059.
