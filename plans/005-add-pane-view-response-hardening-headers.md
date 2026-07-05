# Plan 005: Add Pane View Response Hardening Headers

> **Executor instructions**: Run the drift check first. Start with a minimal,
> testable header layer; do not guess at a CSP that breaks TanStack Start assets.
> Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 8f19cd4..HEAD -- apps/pane-view/src apps/pane-view/vite.config.ts apps/pane-view/package.json`

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-add-github-actions-verification-baseline.md
- **Category**: security
- **Planned at**: commit `8f19cd4`, 2026-07-05
- **Pull request**: https://github.com/Traydr/latch-works/pull/51
- **Follow-up**: https://github.com/Traydr/latch-works/pull/52 fixed CSP
  compatibility with TanStack Start hydration scripts.
- **Merged**: 2026-07-05, plan merge commit `651cbb4`, follow-up merge commit
  `5cdd0e9`
- **Verified**: GitHub `Check` passed on PR #51 and latest `main` check passed
  at https://github.com/Traydr/latch-works/actions/runs/28746243602

## Completion Notes

- Added a central Pane View security header helper/middleware.
- Added CSP `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, and
  `Referrer-Policy: same-origin`.
- PR #52 loosened the script directive enough for TanStack Start hydration while
  preserving the response hardening intent.
- Added security header and delivery compatibility tests.

## Why This Matters

Pane View is an authenticated private browser surface with destructive owner-only
management actions. It currently has no Content Security Policy, frame embedding
restriction, `nosniff`, or referrer policy. Adding these headers reduces the
blast radius of future injection bugs and prevents clickjacking of `/manage`.

## Current State

- `apps/pane-view/src/routes/__root.tsx:19-38` only returns metadata, favicon
  links, and the app stylesheet.
- `apps/pane-view/vite.config.ts:39-42` configures dev server port and plugins,
  but no headers or route rules.
- `apps/pane-view/src/routes/manage.tsx:5-9` gates `/manage` by session but does
  not set route-specific frame headers.
- Grep for `Content-Security-Policy`, `X-Content-Type-Options`,
  `X-Frame-Options`, `frame-ancestors`, and `Referrer-Policy` found no matches.

## Commands You Will Need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Pane View tests | `pnpm --filter @latch-works/pane-view test -- headers cdn-response` | exit 0 |
| Typecheck | `pnpm --filter @latch-works/pane-view typecheck` | exit 0 |
| Build | `pnpm --filter @latch-works/pane-view build` | exit 0 |

## Scope

**In scope**:
- A Pane View server header helper or middleware
- `apps/pane-view/vite.config.ts` or TanStack Start/Nitro server entry if that is
  the supported hook
- `apps/pane-view/src/server/media/cdn-response.ts` only for delivery-specific
  headers not covered by Plan 004
- Header tests

**Out of scope**:
- Authentication changes.
- Rewriting routing or converting Pane View to SPA.
- Caching changes for media delivery.

## Git Workflow

- Branch: `advisor/005-pane-view-security-headers`
- Commit message: `Add Pane View security headers`

## Steps

### Step 1: Identify The Supported Header Hook

Find the TanStack Start/Nitro-supported way to set headers for all responses in
this app. Prefer a central server middleware or Nitro route rules over adding
headers route-by-route. If the current versions do not expose a stable hook,
STOP and report rather than hand-rolling unsupported server code.

**Verify**: `pnpm --filter @latch-works/pane-view typecheck` -> exits 0 after adding only the hook skeleton and tests compile.

### Step 2: Add Baseline Headers

For HTML/app routes, set at minimum:

```text
X-Content-Type-Options: nosniff
Referrer-Policy: same-origin
Content-Security-Policy: frame-ancestors 'none'; default-src 'self'; object-src 'none'; base-uri 'self'
```

Do not add a strict `script-src` or `style-src` until you verify the generated
TanStack Start/Vite output. If needed, start with `Content-Security-Policy-Report-Only`
for script/style directives and enforce only `frame-ancestors`, `object-src`, and
`base-uri` first.

**Verify**: `pnpm --filter @latch-works/pane-view build` -> exits 0.

### Step 3: Keep Media Delivery Compatible

Ensure `/cdn/v1/*`, `/api/media/:id/original`, `/api/media/:id/thumbnail`, and
`/api/media/:id/preview` still work with redirects/range responses. These routes
should at least include `nosniff` and `Referrer-Policy: same-origin`, but should
not receive an HTML-only CSP that blocks image/video loading.

**Verify**: `pnpm --filter @latch-works/pane-view test -- cdn-response` -> delivery response tests pass.

### Step 4: Add Header Tests

Add tests for the helper/middleware and at least one representative app route.
If route-level integration is difficult, test the header helper directly and add
one server handler test where practical.

**Verify**: `pnpm --filter @latch-works/pane-view test -- headers` -> all new tests pass.

## Test Plan

- Tests for app-route headers including `frame-ancestors 'none'`.
- Tests for media delivery preserving range/content headers while adding
  hardening headers.
- Manual smoke after build: login page renders, gallery renders, media thumbnail
  URLs still load.

## Done Criteria

- [x] Pane View app routes set `frame-ancestors 'none'` through CSP.
- [x] Pane View responses set `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: same-origin`.
- [x] Media delivery routes are not broken by HTML-only CSP.
- [x] Build, focused tests, and the GitHub `Check` workflow exited 0.
- [x] `plans/README.md` status row updated.

## STOP Conditions

- There is no stable header hook in the installed TanStack Start/Nitro versions.
- CSP breaks the built app and cannot be fixed without large routing/build
  changes.
- You need to convert Pane View to SPA to set headers. That is out of scope.

## Maintenance Notes

- Future external hosts such as Bunny or S3 must be added deliberately to CSP
  directives when enforced beyond the baseline directives above.
