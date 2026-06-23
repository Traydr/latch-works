# Plan 019: Repair Stale README And Docs Links

> **Executor instructions**: Run the drift check first. This is docs-only. Update
> `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 027d48a..HEAD -- README.md apps/pane-view/README.md docs/ARCHITECTURE.md docs/next-recommendations.md docs/media-optimizer-internals.md docs/runbooks/pane-view-thumbnails.md docs/gather-box-sidecar-manifests.md`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/018-fix-local-service-onboarding-docs.md
- **Category**: docs
- **Planned at**: commit `027d48a`, 2026-06-23

## Why This Matters

The root README and architecture docs are entry points for humans and agents.
They omit real workspace members, list phantom docs paths, and link to missing
architecture/prewarm files. Broken evidence links make roadmap docs less
trustworthy.

## Current State

- `README.md:44-61` omits `apps/media-optimizer` and
  `packages/media-derivatives` from the app/package inventory.
- `README.md:82-86` lists `docs/ARCHITECTURE_PLAN.md`, `docs/decisions/`, and
  `docs/plans/`; none exist.
- `README.md:169` links `docs/ARCHITECTURE_PLAN.md`, which does not exist.
- Grep found missing-doc references to `ARCHITECTURE_PLAN.md`,
  `end-to-end-request-flow.md`, and `derivative-prewarm-and-workers.md` in
  README, Pane View README, `docs/ARCHITECTURE.md`, `docs/next-recommendations.md`,
  `docs/media-optimizer-internals.md`, `docs/runbooks/pane-view-thumbnails.md`,
  and `docs/gather-box-sidecar-manifests.md`.

## Commands You Will Need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Link grep | `grep -R "ARCHITECTURE_PLAN\|end-to-end-request-flow\|derivative-prewarm-and-workers" README.md apps/pane-view/README.md docs/*.md docs/runbooks/*.md` | no stale refs unless deliberately restored |
| Docs lint | `pnpm lint` | exit 0 or only unrelated pre-existing issues |

## Scope

**In scope**:
- Root README inventory, tree, and documentation table
- Docs links to missing files
- `docs/next-recommendations.md` evidence citations that point at missing files

**Out of scope**:
- Recreating large historical docs unless the maintainer explicitly wants them.
- Product direction changes beyond correcting citations.

## Git Workflow

- Branch: `advisor/019-stale-doc-links`
- Commit message: `Repair stale documentation links`

## Steps

### Step 1: Update README Inventory

Add rows for `apps/media-optimizer` and `packages/media-derivatives`, using the
descriptions from `docs/ARCHITECTURE.md:51-65`. Update the workspace tree to
include `docs/adr/`, `docs/localhost/`, and `docs/runbooks/`, and remove phantom
`docs/decisions/` and `docs/plans/`.

**Verify**: `grep -n "media-optimizer\|media-derivatives" README.md` -> both appear in inventory sections.

### Step 2: Replace Missing Architecture Links

Replace active links to `docs/ARCHITECTURE_PLAN.md` with `docs/ARCHITECTURE.md`
unless the link is explicitly historical and the file is restored. Update
`apps/pane-view/README.md` and `docs/gather-box-sidecar-manifests.md` similarly.

**Verify**: `grep -R "ARCHITECTURE_PLAN" README.md apps/pane-view/README.md docs/*.md` -> no matches unless a restored file exists.

### Step 3: Repair Flow And Prewarm References

For `end-to-end-request-flow.md`, point readers to the sequence diagrams in
`docs/ARCHITECTURE.md`. For `derivative-prewarm-and-workers.md`, either restore
the file or repoint to live docs such as `docs/media-optimizer-internals.md` and
`docs/runbooks/pane-view-thumbnails.md`. Update `docs/next-recommendations.md`
evidence lines so every cited file exists.

**Verify**: the link grep command above reports no stale references.

## Test Plan

- Docs-only.
- Link grep verifies stale references are gone.
- Optional: run a Markdown link checker if one exists; do not add a new tool.

## Done Criteria

- [ ] README lists all current apps and shared packages.
- [ ] README docs tree matches the actual `docs/` structure.
- [ ] No active links point to missing architecture/prewarm docs.
- [ ] `docs/next-recommendations.md` citations point to live evidence.
- [ ] `plans/README.md` status row updated.

## STOP Conditions

- Maintainer wants to restore missing historical docs instead of repointing.
- You cannot find live evidence for a recommendation whose citation is dead.

## Maintenance Notes

- Avoid line-number citations to volatile docs unless they are regenerated during
  each docs update.
