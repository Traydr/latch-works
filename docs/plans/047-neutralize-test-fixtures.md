# Plan 047: Neutralize repository-visible test fixtures

> **Executor instructions**: Content-only cleanup. Every change must keep the assertion it supports
> exactly as strong as it is now. If neutralizing a fixture would weaken coverage, keep the fixture
> and record why in the plan.
>
> **Drift check (run first)**: `git diff --stat c0a1bdf..HEAD -- apps/gather-box/src/shared apps/pane-view/src/server/library`

## Status

- **Status**: DONE
- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Category**: developer experience / presentation

## Implementation notes

- Completed 2026-07-27.
- Reddit fixtures now use neutral community and user paths, while the Hentai Foundry detection case
  remains to preserve explicit unlisted-source coverage.
- Opaque `sfw/patreon` paths were replaced with neutral photo archive paths in the named repository
  suite and in three additional test files found by the required sweep.
- Remaining sweep hits are source-specific collector, resolver, and download-policy coverage whose
  module names already carry the source name.
- The `sfw` paths left in `paths.test.ts`, `sync-plan.test.ts`, and `plan-sync.test.ts` were kept
  deliberately. "SFW" does imply a counterpart, so the justification is not that the string is
  neutral — it is that `SFW`/`sfw` is doing real work there as a case-folding fixture pair, and
  substituting it would weaken the assertion these suites exist to make.

## Why this matters

The repository is now public. Gather Box's unlisted-source work deliberately kept collectors in the
codebase while removing their names from docs and browsable UI, on the reasoning that anyone reading
`src/content/collectors/` has already opted in. Test fixtures are a different case: they are literal
content strings a casual reader encounters while scanning for how the code is tested, and they carry
no coverage value in their specific wording.

Two files still carry fixture content that the documentation pass removed everywhere else:

| File | Fixture |
|---|---|
| `apps/gather-box/src/shared/sites.test.ts` | Reddit and Hentai Foundry URLs naming adult communities |
| `apps/pane-view/src/server/library/repository.test.ts` | `"sfw/patreon"` archive paths, which imply the sibling |

This is presentation, not correctness. It is filed separately from Plan 046 because it shares none of
that plan's risk and can land at any time.

## Current state

- `sites.test.ts` asserts positive and negative URL detection per source. The assertions matter; the
  specific hostnames in the positive cases mostly do not, with one exception noted below.
- `repository.test.ts` uses archive-like paths purely as opaque strings for scope resolution.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Gather tests | `pnpm --filter @latch-works/gather-box test` | detection suites pass |
| Pane tests | `pnpm --filter @latch-works/pane-view test` | repository suites pass |
| Check | `pnpm check` | full workspace gate passes |

## Scope

**In scope**: fixture strings in the two files above.

**Out of scope**: renaming collector modules or catalog keys (explicitly decided against — the
filenames stay); changing which sources are unlisted; changing any assertion's strength.

## Git workflow

- Branch: `codex/047-neutralize-test-fixtures`
- Commit message: `Neutralize repository-visible test fixtures`

## Steps

### Step 1: Replace Pane View archive path fixtures

Swap `"sfw/patreon"` for a neutral nested path such as `"photos/2026"` throughout
`repository.test.ts`. These strings are opaque to `resolveMediaScope`; only their nesting shape
matters, so this is a pure rename.

**Verify**: `repository.test.ts` passes unchanged in structure and assertion count.

### Step 2: Replace Gather Box detection fixtures

In `sites.test.ts`, replace adult-community URLs in the Reddit cases with neutral subreddit paths of
the same shape (`/r/<name>/comments/<id>/<slug>/` and `/user/<name>/comments/...`).

Keep at least one unlisted-source URL in the detection table. Detection coverage for unlisted sources
is exactly the invariant `source-catalog.test.ts` protects, and dropping it would weaken a guarantee
this repository deliberately established. A `hentai-foundry.com` path is the natural choice; leave it
in place and neutralize only the Reddit entries around it.

**Verify**: the positive and negative case counts are unchanged; unlisted sources are still covered
by at least one detection assertion.

### Step 3: Confirm no other fixture drift

Re-run the sweep the documentation pass used, restricted to test files:

```bash
git grep -niE 'hentai|kemono|redgif|myhentai|fanbox|nsfw|sfw' -- '*.test.ts' '*.test.tsx'
```

Expected remaining hits: the deliberate detection fixture from Step 2, and collector-fixture files
whose module names already carry the source name. Anything else is drift to clean.

**Verify**: the sweep output matches that expectation and is recorded in the commit body.

## Test plan

No new tests. Every existing assertion must survive with identical strength; the diff should be
string substitutions only, with no change to assertion counts in either file.
