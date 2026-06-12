# Repository Guidelines

## Project Structure & Module Organization

Latch Works is a private TypeScript pnpm workspace for collecting, syncing, and viewing a personal media archive. Workspace packages are declared in `pnpm-workspace.yaml`.

- `apps/pane-view/`: TanStack Start web viewer, routes, server code, Drizzle config, and Vitest tests.
- `apps/frame-view/`: Electron image/video viewer.
- `apps/gather-box/`: browser-extension style collector build.
- `packages/media-domain/`: shared media types, path logic, sorting, and domain tests.
- `packages/media-index/`: archive scanning and sync-plan logic.
- `packages/media-storage/`: storage key and S3 integration helpers.
- `apps/lockstep-cli/`: CLI for planning and running local archive sync work.
- `docs/`: decisions and runbooks.

Source lives in each package's `src/` directory. Tests are colocated as `*.test.ts`.

## Build, Test, and Development Commands

- `pnpm install`: install workspace dependencies.
- `pnpm check`: build, test, and typecheck all recursive workspace packages.
- `pnpm build`: run every package build script.
- `pnpm test`: run all Vitest suites.
- `pnpm typecheck`: run TypeScript checks across the workspace.
- `pnpm lint`: run Biome checks from the repo root.
- `pnpm format`: format the repo with Biome.

## Coding Style & Naming Conventions

This repo uses TypeScript ESM, pnpm 11.1.0, and Biome. Formatting is 2-space indentation, 100-column line width, organized imports, and recommended lint rules. Prefer named exports in shared packages and route public package APIs through `src/index.ts`. Use kebab-case directories and descriptive file names such as `sync-plan.ts`.

## Testing Guidelines

Vitest is the test runner. Keep tests close to the code they cover and name them after the module under test, for example `media.test.ts` or `store.test.ts`. Run focused tests with `pnpm --filter @latch-works/media-index test`, then run `pnpm check` before larger handoffs.

## Commit & Pull Request Guidelines

Recent commits use short imperative summaries, for example `Add authenticated thumbnail delivery` and `Fix Lockstep capped push progress and uploads`.

Pull requests should include the purpose, affected app/package, verification commands, linked issues when applicable, and screenshots for visible UI changes.

## Security & Configuration Tips

Do not commit secrets. Keep local values in `.env` and document required keys in `.env.example`. Treat the local archive as the source of truth; commands that mutate archive or storage state should be explicit and documented in the PR.

## Cursor Cloud specific instructions

### Local services (Pane View E2E)

Pane View requires PostgreSQL and S3-compatible storage. There is no docker-compose in the repo; start services manually when testing sync or the web app:

- **PostgreSQL**: `sudo pg_ctlcluster 16 main start` (database `latch_works`, user/password from `.env`).
- **MinIO** (local S3): run in a tmux session, e.g. `MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin123 /tmp/minio server /tmp/minio-data --address 127.0.0.1:9000 --console-address 127.0.0.1:9001`, then create bucket `latch-works-media` with the `mc` client.

Copy `.env.example` to repo-root `.env`, symlink `apps/pane-view/.env` → `../../.env`, then migrate: `cd apps/pane-view && set -a && . ./.env && set +a && pnpm db:migrate`.

### Build before dev

`pnpm dev:pane` resolves workspace packages (`@latch-works/media-*`) from their built `dist/` output. Run `pnpm build` (or `pnpm -r --filter './packages/*' build`) before starting the dev server, or routes like `/api/health` will fail with package resolution errors.

### Running Pane View and Lockstep

- Web app: `pnpm dev:pane` → http://127.0.0.1:3000 (`GET /api/health` should return `{"ok":true,"service":"pane-view"}`).
- Lockstep plan (read-only): `cd apps/lockstep-cli && pnpm exec tsx src/cli.ts plan --source <archive-path>` with `.env` sourced.
- Lockstep push: same, with `push --source <path> --api-url http://127.0.0.1:3000 --yes`.

Do not pass `--` between `pnpm start:lockstep` and subcommands; use `pnpm exec tsx src/cli.ts plan ...` from `apps/lockstep-cli` or `pnpm --filter @latch-works/lockstep start plan --source ...`.

- Gallery thumbnails and viewer images resolve signed S3 URLs through the `resolveMediaDeliveryUrl` server function (`useResolvedMediaUrl` hook). Do not point `<img src>` at `/api/media/...` in dev: Vite returns 404 for those requests when `Sec-Fetch-Dest: image`.
- API thumbnail/preview routes redirect to signed storage URLs via `delivery-redirect.ts`. CDN tokens use `~` as the payload/signature separator and the splat route `cdn.v1.$.ts`.
- Verify image loading: log in at `/login`, browse `/?path=photos`, then run `pnpm --filter @latch-works/pane-view check`.

### Test caveats on Linux

- `pnpm check` fails on Linux because `apps/frame-view` has a Windows-path unit test (`mediaProtocol.test.ts`). Other frame-view tests may emit `window is not defined` noise in Node. Run workspace tests excluding frame-view, or accept this known failure for full `pnpm check`.
- `apps/lockstep-cli` tests expect `LOCKSTEP_API_URL` to be unset when asserting missing-field behavior. If repo-root `.env` is sourced, run `env -u LOCKSTEP_API_URL -u LOCKSTEP_API_TOKEN pnpm --filter @latch-works/lockstep test`.
- `pnpm lint` may report pre-existing Biome format/import issues unrelated to your changes.

### Service startup after VM boot

PostgreSQL and MinIO are not started automatically. Before Pane View E2E:

```bash
sudo pg_ctlcluster 16 main start
# MinIO (if /tmp/minio exists from a prior session; otherwise re-download from https://min.io/download)
MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin123 /tmp/minio server /tmp/minio-data --address 127.0.0.1:9000 --console-address 127.0.0.1:9001
```
