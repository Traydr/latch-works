# Plan 006: Resolve High Dependency Advisories

> **Executor instructions**: Run the drift check and baseline audit first. Do not
> use `pnpm audit --fix`; update manifests deliberately. Update
> `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 8f19cd4..HEAD -- package.json pnpm-lock.yaml pnpm-workspace.yaml apps/*/package.json packages/*/package.json`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-add-github-actions-verification-baseline.md
- **Category**: security, migration
- **Planned at**: commit `8f19cd4`, 2026-07-05

## Why This Matters

The last successful advisor audit reported high advisories. Some affect
runtime-facing dev servers/frameworks (`vite`, `astro`), while others affect
Electron packaging transitive dependencies (`tar`, `tmp`). The goal is a clean
high-severity audit without broad, unreviewed dependency churn.

## Current State

- Root `package.json:22-27` includes Biome, Knip, Railway, TypeScript, Vitest.
- Pane View pins `vite` at `8.0.11` in `apps/pane-view/package.json:57`.
- Frame View and Lockstep use `vite` ranges around `^8.0.7` in their manifests.
- Showcase uses `astro` in `apps/showcase/package.json:22` plus Astro adapters.
- `pnpm-workspace.yaml:5-8` already uses overrides for native/package tooling.
- The last successful advisor run of `pnpm audit --audit-level high` was on
  2026-06-28 and reported 21 total advisories: 10 high, 8 moderate, and 3 low.
  The high advisories were for `vite`, `astro`, `tar`, and `tmp`.
- A 2026-07-05 audit attempt failed in the sandbox with registry DNS/network
  errors. A network rerun was not performed because `pnpm audit` sends private
  dependency metadata to the public npm registry; get operator approval before
  refreshing this baseline externally.
- Last known patched targets from the successful audit: `tar >=7.5.11`,
  `tmp >=0.2.6`, `vite >=8.0.16`, and `astro >=6.4.6`.

## Commands You Will Need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Baseline audit | `pnpm audit --audit-level high` | nonzero if high advisories remain; may require operator-approved registry access |
| Install/update | `pnpm install` | exit 0 and lockfile updated |
| Audit gate | `pnpm audit --audit-level high` | exit 0 |
| Full check | `pnpm check` | exit 0 |
| Showcase check | `pnpm --filter @latch-works/showcase check` | exit 0 |

## Scope

**In scope**:
- Root and app `package.json` dependency ranges
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml` overrides only if upstream ranges cannot resolve patched
  transitive versions

**Out of scope**:
- Feature migrations unrelated to dependency compatibility.
- Replacing Astro, Vite, Electron Forge, or Vitest.
- Ignoring advisories without a documented unreachable-runtime rationale.

## Git Workflow

- Branch: `advisor/006-dependency-advisories`
- Commit message: `Resolve high dependency advisories`

## Steps

### Step 1: Capture The Baseline

Run `pnpm audit --audit-level high` and save the package/advisory names in the
PR notes. Do not copy secrets or environment values. Confirm the high advisories
still include the packages listed above, and note any new packages separately.
If the operator does not approve external registry access, stop after recording
that the live advisory baseline could not be refreshed.

**Verify**: `pnpm audit --audit-level high` -> nonzero with the expected high advisories.

### Step 2: Update Runtime-Facing Frameworks First

Update all Vite 8 consumers to a patched version satisfying the audit, at least
`>=8.0.16`. Keep version ranges consistent across Pane View, Frame View,
Lockstep, and root Vitest/Vite consumers.

Update Showcase Astro and Astro adapters together to a patched compatible line
that satisfies the audit. Expect this may be a major Astro upgrade; read the
Astro migration notes before editing source.

**Verify**: `pnpm install && pnpm --filter @latch-works/showcase check && pnpm --filter @latch-works/pane-view check` -> all exit 0.

### Step 3: Resolve Electron Packaging Transitives

If `tar` or `tmp` high advisories remain through Electron Forge packaging after
normal dependency updates, add the narrowest root `pnpm-workspace.yaml` override
for patched `tar` and/or `tmp` versions. Keep overrides targeted and explain in
the PR why the advisory is in packaging/dev tooling.

**Verify**: `pnpm install && pnpm audit --audit-level high` -> exits 0.

### Step 4: Run Full Verification

Run the full workspace check. If CI from Plan 001 exists, push only after the
workflow is expected to pass.

**Verify**: `pnpm check` -> exits 0.

## Test Plan

- No new tests unless framework migrations require source changes.
- Required checks: `pnpm audit --audit-level high`, `pnpm check`, and focused
  Showcase/Pane View checks.

## Done Criteria

- [ ] `pnpm audit --audit-level high` exits 0.
- [ ] Vite ranges are aligned to a patched version.
- [ ] Showcase builds on patched Astro/adapters.
- [ ] Any overrides are minimal and documented in the PR notes.
- [ ] `pnpm check` exits 0.
- [ ] `plans/README.md` status row updated.

## STOP Conditions

- Astro migration requires redesigning Showcase pages or routing.
- A patched transitive version breaks Electron Forge packaging scripts.
- Audit remains high after reasonable updates and the remaining advisory affects
  reachable runtime code.
- Operator approval for the registry audit is unavailable, so the executor
  cannot verify the current advisory baseline.

## Maintenance Notes

- Do not suppress high advisories globally. If one remains unreachable, record
  the exact dependency path and rationale in docs or PR notes.
