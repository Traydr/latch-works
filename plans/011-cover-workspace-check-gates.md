# Plan 011: Make Root Verification Cover The Advertised Gates

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving to the next step. If any
> STOP condition occurs, stop and report instead of improvising. When done,
> update this plan's row in `plans/README.md` unless a reviewer says they own the
> index.
>
> **Drift check (run first)**:
> `git diff --stat 326110f..HEAD -- package.json pnpm-workspace.yaml biome.json knip.json apps/*/package.json packages/*/package.json`
> If any in-scope file changed, compare the excerpts below with the live code
> before proceeding. A mismatch is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `326110f`, 2026-06-12

## Why this matters

The root README and AGENTS guidance advertise build, test, typecheck, lint, and
format as workspace-level gates. The root `pnpm check` currently runs build,
tests, and typecheck, but not lint or Knip. Biome also excludes two apps, and
Knip only covers the root and Pane View. That means a green root check can miss
dead exports, lint failures, or entire app surfaces.

## Current state

- Root `package.json` owns workspace scripts.
- `biome.json` excludes `apps/frame-view` and `apps/gather-box`.
- `knip.json` only declares workspaces for `.` and `apps/pane-view`.
- Some package-level `check` scripts are richer than root `check`, but they are
  not the source of truth.

Relevant excerpts at `326110f`:

```json
// package.json:7-14
"scripts": {
  "build": "pnpm -r build",
  "check": "pnpm -r --sort build && pnpm -r test && pnpm -r typecheck",
  "format": "biome format --write .",
  "lint": "biome check .",
  "test": "pnpm -r test",
  "typecheck": "pnpm -r typecheck",
  "knip": "knip"
}
```

```json
// biome.json:5-13
"includes": [
  "**",
  "!**/node_modules",
  "!**/dist",
  "!**/.output",
  "!**/routeTree.gen.ts",
  "!apps/frame-view",
  "!apps/gather-box"
]
```

```json
// knip.json:12-24
"workspaces": {
  ".": {},
  "apps/pane-view": {
    "entry": [
      "drizzle.config.ts",
      "vite.config.ts",
      "vitest.config.ts",
      "src/router.tsx",
      "src/routeTree.gen.ts",
      "src/routes/**/*.{ts,tsx}"
    ],
    "drizzle": false
  }
}
```

Package examples:

```json
// apps/frame-view/package.json:14-18
"lint": "biome check .",
"typecheck": "tsc --noEmit",
"check": "pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run knip",
"knip": "knip"
```

```json
// apps/gather-box/package.json:7-11
"build": "node scripts/build.mjs",
"check": "pnpm typecheck && pnpm test && pnpm build",
"lint": "pnpm exec biome check src",
"test": "vitest run",
"typecheck": "tsc --noEmit"
```

Repo conventions to match:

- pnpm workspace, TypeScript ESM, Biome, Vitest, and Knip.
- Avoid broad formatting churn unless the plan explicitly needs it.
- Known caveat from AGENTS: root `pnpm lint` may report pre-existing Biome
  issues, and Linux frame-view tests may have a Windows-path caveat.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Root check | `pnpm check` | exit 0, covers build/test/typecheck/lint/knip or documents accepted caveats |
| Lint | `pnpm lint` | exit 0, no Biome errors |
| Knip | `pnpm knip` | exit 0, no unexpected unused files/exports/deps |
| Package checks | `pnpm -r --filter './apps/*' --filter './packages/*' --if-present check` | exit 0, package checks pass |

## Scope

**In scope**:

- `package.json`
- `biome.json`
- `knip.json`
- App/package `package.json` files, only to standardize `check`, `lint`, or
  `knip` scripts
- Minimal lint/Knip fixes only if they are small and directly required
- `plans/README.md`, status row only

**Out of scope**:

- Refactoring app code for style preferences.
- Dependency upgrades.
- CI provider configuration unless a CI file already exists and directly calls
  old scripts.
- Reformatting the whole repo as a side effect.

## Git workflow

- Branch: `codex/011-cover-workspace-check-gates`
- Commit style: short imperative summary, for example
  `Cover workspace verification gates.`
- Do not push or open a PR unless the operator asks.

## Steps

### Step 1: Inventory package check scripts

Run read-only script inventory:

`pnpm -r exec node -e "const p=require('./package.json'); console.log(process.cwd(), p.scripts)"`

If that command is awkward under ESM/package boundaries, inspect package files
with `rg '"check"|"lint"|"knip"' apps packages package.json`.

Record which packages lack `check`, `lint`, or `knip` scripts and decide whether
root should call root-level tools or per-package tools for each gate.

**Verify**:
`rg '"check"|"lint"|"knip"' package.json apps packages` -> output reviewed.

### Step 2: Standardize root `check`

Update root `package.json` so `pnpm check` covers:

- package build/test/typecheck through package `check` scripts or explicit root
  recursive commands
- Biome lint in check mode
- Knip

Avoid recursive self-calls. A safe shape is a dedicated helper script, for
example:

```json
"check:packages": "pnpm -r --filter './apps/*' --filter './packages/*' --sort --if-present check",
"check": "pnpm run check:packages && pnpm run lint && pnpm run knip"
```

Adjust the exact pnpm filter syntax if needed after verifying locally.

**Verify**:
`pnpm run check:packages` -> exit 0, or only known documented package caveats.

### Step 3: Bring Biome coverage in line

Remove blanket `!apps/frame-view` and `!apps/gather-box` exclusions from
`biome.json` if those apps can pass `biome check`. Keep necessary generated or
build-output exclusions.

If one app has many pre-existing style issues, do not reformat the app in this
plan. Instead, keep the exclusion and add a package-local `lint`/follow-up note
that names the blocker. The preferred outcome is full Biome coverage, but avoid
large noisy diffs.

**Verify**:
`pnpm lint` -> exit 0, or STOP if it reveals broad unrelated churn.

### Step 4: Expand Knip workspaces

Update `knip.json` to include all active apps and packages with sensible entry
points. Use existing package exports, app config files, and route/preload/main
entry points as anchors. Do not silence findings with broad ignore patterns
unless they are generated files or documented framework entry points.

**Verify**:
`pnpm knip` -> exit 0, or STOP if it surfaces many unrelated real findings.

### Step 5: Run the final root gate

Run the new root `check`.

**Verify**:
`pnpm check` -> exit 0. If a known platform caveat is accepted by the operator,
record it in the PR/summary and make sure the remaining gates pass.

## Test plan

- This is a tooling plan; verification commands are the tests.
- Add no product tests unless small script changes require them.
- Avoid `pnpm format` unless the operator explicitly accepts broad formatting
  changes.

## Done criteria

- [ ] Root `pnpm check` includes lint and Knip, not only build/test/typecheck.
- [ ] Biome coverage no longer silently excludes major apps without a documented
      reason.
- [ ] Knip covers all active apps/packages or documents precise exclusions.
- [ ] `pnpm check`, `pnpm lint`, and `pnpm knip` pass, or accepted caveats are
      documented.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

Stop and report if:

- Adding lint/Knip exposes broad pre-existing issues that require touching many
  unrelated source files.
- pnpm recursive filters recurse into the root `check` script.
- Linux-only frame-view caveats are the only blocker and the operator needs a
  cross-platform check strategy decision.

## Maintenance notes

After this lands, new packages should define a package-level `check` script or be
covered by root scripts explicitly. Reviewers should check for accidental
recursive `pnpm check` loops.
