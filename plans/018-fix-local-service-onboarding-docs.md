# Plan 018: Fix Local-Service Onboarding Docs

> **Executor instructions**: Run the drift check first. This is docs-only. Do not
> copy or introduce secret values. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 027d48a..HEAD -- AGENTS.md README.md docs/localhost/README.md docs/localhost/compose.yaml docs/ARCHITECTURE.md`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs, dx
- **Planned at**: commit `027d48a`, 2026-06-23

## Why This Matters

Top-level agent/onboarding docs currently say there is no Docker Compose stack,
but the repository contains a compose stack for PostgreSQL and S3-compatible
storage. Agents and contributors are steered toward a stale manual MinIO path
instead of the committed localhost setup.

## Current State

- `AGENTS.md:73` says there is no docker-compose in the repo.
- `AGENTS.md:75-76` points at manual PostgreSQL and MinIO startup. Line 76 also
  contains local-development default credential text; do not reproduce those
  values in new docs beyond existing local examples.
- `AGENTS.md:111-116` repeats manual startup instructions.
- `docs/localhost/README.md:3-8` documents a Docker Compose stack with
  PostgreSQL 18.4, RustFS S3 on `127.0.0.1:9000`, RustFS console on `9001`, and
  a bucket init container.
- `docs/localhost/compose.yaml:1-63` is the committed compose stack.
- `docs/ARCHITECTURE.md:575` still says local development uses MinIO as S3.

## Commands You Will Need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Docs lint | `pnpm lint` | exit 0 or only documented pre-existing unrelated issues |

## Scope

**In scope**:
- `AGENTS.md`
- `README.md` brief local-services pointer if helpful
- `docs/ARCHITECTURE.md` local-dev wording
- `docs/localhost/README.md` only if wording needs clarification

**Out of scope**:
- Changing compose services.
- Changing `.env.example` values.
- Starting local services.

## Git Workflow

- Branch: `advisor/018-local-service-docs`
- Commit message: `Fix localhost service docs`

## Steps

### Step 1: Make docs/localhost Canonical

Rewrite `AGENTS.md` local services section to say the primary path is
`docs/localhost/README.md` and `docker compose up -d` from `docs/localhost`.
Keep manual PostgreSQL/MinIO commands only as an explicit fallback for
environments where Docker is unavailable, not as the canonical repo state.

**Verify**: `grep -n "There is no docker-compose" AGENTS.md` -> no matches.

### Step 2: Align Architecture Wording

Update `docs/ARCHITECTURE.md:575` to reference root `.env`,
`docs/localhost`, PostgreSQL, and RustFS/S3-compatible storage instead of MinIO
as the default local stack.

**Verify**: `grep -n "MinIO" docs/ARCHITECTURE.md AGENTS.md` -> only fallback or historical mentions remain.

### Step 3: Add A Root README Pointer

Add a concise line in README prerequisites/getting-started that local PostgreSQL
and S3-compatible storage can be started with `docs/localhost/compose.yaml`.

**Verify**: `pnpm lint` -> exits 0 or reports only unrelated pre-existing issues.

## Test Plan

- Docs-only. No runtime tests.
- Optional manual check: `docs/localhost/README.md` still contains the full
  startup sequence.

## Done Criteria

- [ ] Top-level docs no longer falsely say no compose stack exists.
- [ ] `docs/localhost` is linked as the canonical local service setup.
- [ ] Architecture doc local-dev wording matches RustFS compose stack.
- [ ] No secret values are newly introduced.
- [ ] `plans/README.md` status row updated.

## STOP Conditions

- The compose stack is intentionally deprecated and should be removed instead.
- Updating docs requires changing local service implementation.

## Maintenance Notes

- If Cursor Cloud cannot use Docker, keep that as an environment-specific
  fallback note, not a statement about repository contents.
