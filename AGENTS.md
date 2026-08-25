# Repository Guidelines

## Project structure and module organization

Latch Works is a TypeScript pnpm workspace. Product code lives under `apps/`: `pane-view` is the
web viewer; `frame-view` and `lockstep` are Electron apps; `gather-box` is a Chrome extension;
`lockstep-cli` is the sync CLI; and `showcase` is the Astro site. Shared code belongs in
`packages/`.

Keep source in each workspace's `src/`. Tests sit beside modules as `*.test.ts` or in
`apps/*/tests/`. Put decisions, plans, and runbooks in `docs/`. Keep `dist/`, `out/`, and
`.output/` untracked.

## Build, test, and development commands

- `pnpm install`: install workspace dependencies with pnpm 11.
- `pnpm test`: run all Vitest suites.
- `pnpm typecheck`: check TypeScript across the workspace.
- `pnpm lint:all`: run Biome and the repository's Oxlint anti-slop rules.
- `pnpm build:all`: build all workspaces and Electron distributables.
- `pnpm check:all`: build, format, lint, typecheck, and run Knip. This command rewrites files
  through `pnpm format`, so inspect the resulting diff.
- `pnpm --filter @latch-works/pane-view dev`: start Pane View on port 3000. Use another package
  name to run its scripts.

## Coding style and naming conventions

Use TypeScript ESM. Biome enforces two-space indentation, a 100-column limit, lint rules, and
organized imports. Run `pnpm format` after edits. Use kebab-case file names such as
`sync-plan.ts`, PascalCase for components and classes, and camelCase for functions and values.
Export shared APIs through `src/index.ts`. Preserve Electron's main/preload/renderer boundary.

## Testing guidelines

Use Vitest and name tests after the module, such as `scan.test.ts`. Write whatever tests you
need to prove your change works, but committing a test is a separate decision: commit one only
when explicitly asked, or when it pins a feature's behavior that is worth keeping (ordering rules,
sync invariants, parser output). Do not commit tests for one-off bug fixes, configuration
choices, or the absence of something. Prefer tests that exercise real dependencies and assert on
output over tests that mock a module's collaborators and assert on calls; the end-to-end suite is
the place to confirm user-facing features. Run a focused suite first, for example
`pnpm --filter @latch-works/media-index test`, then run `pnpm test` and `pnpm typecheck`. The
repository does not define a numeric coverage threshold.

The end-to-end suite lives in `e2e/` (Playwright) and is the final check before a PR is ready:
`pnpm e2e:pane` runs Pane View against the local compose stack, seeded through the Lockstep CLI.
It is not part of `pnpm test`; see `docs/runbooks/e2e.md` for prerequisites and how to run one
spec.

## Commit and pull request guidelines

Recent commits use short, imperative subjects such as `Add anti-slop Oxlint plugin and config`.
Keep each commit scoped to one change. Pull requests should explain the effect, name affected
workspaces, link the issue or plan, and list verification commands. Include screenshots for UI
changes. Call out schema migrations, environment variables, or compatibility risks.

## Security and configuration

Copy values from `.env.example` into local environment files and never commit credentials.
Treat the local archive as the source of truth. Document any command that mutates archive data,
PostgreSQL state, or object storage.
