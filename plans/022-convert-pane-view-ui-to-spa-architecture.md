# Plan 022: Convert Pane View UI To SPA Architecture While Keeping Server Functions

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report rather than improvising. When done,
> update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat d8f3c52..HEAD -- apps/pane-view/src apps/pane-view/package.json apps/pane-view/vite.config.ts apps/pane-view/tsconfig.json .railway/railway.ts docs/ARCHITECTURE.md`
> If any in-scope file changed since this plan was written, compare the current
> state excerpts below against live code before proceeding.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans/001-add-github-actions-verification-baseline.md, plans/005-add-pane-view-response-hardening-headers.md
- **Category**: tech-debt, architecture
- **Planned at**: commit `d8f3c52`, 2026-06-28

## Why This Matters

The maintainer does not want a PWA, but does want Pane View to behave like a
fully client-rendered SPA. TanStack Start server functions can still be used in
SPA-style routes as long as Pane View keeps a server runtime. The goal is to
move route rendering/auth/data ownership to the browser while preserving the
convenient `createServerFn` RPC boundary for DB/S3/auth work.

## Important Clarification

Do **not** replace server functions with hand-written JSON APIs just because the
UI becomes SPA-style. The installed TanStack Start docs/examples explicitly show
`ssr: false` routes can still call `createServerFn`; the client build receives
RPC stubs for statically imported server functions. Server functions only stop
working if Pane View is converted to a static-only deployment with no server
runtime. That is **not** this plan.

Relevant local documentation from the installed package:

- `apps/pane-view/node_modules/@tanstack/react-start/skills/react-start/server-components/docs/caching-refresh-ssr.md:105-113` says that in `ssr: false`, both loader and component run in the browser, and the loader can still call a server function.
- `apps/pane-view/node_modules/@tanstack/react-start/skills/react-start/server-components/examples/05-ssr-false-browser-loader.tsx:19-24` shows `createFileRoute(... )({ ssr: false, loader: async () => getDrawingTools(...) })`.
- `apps/pane-view/node_modules/@tanstack/react-start/skills/react-start/server-components/docs/debugging-review.md:113-116` says static imports of server functions are safe because the client build gets RPC stubs.

## Current State

- `apps/pane-view/package.json:7-14` builds with `vite build`, serves
  `.output/server/index.mjs`, and typechecks/tests through `tsc`/Vitest.
- `apps/pane-view/vite.config.ts:1-5` uses `@tanstack/react-start/plugin/vite`,
  `nitro/vite`, Tailwind, and React plugins.
- `vite.config.ts:7-22` externalizes server-only packages such as AWS SDK,
  Better Auth, media derivatives/storage, `ffmpeg-static`, and `sharp`.
- `src/router.tsx:9-19` creates a TanStack Router with `routeTree`, React Query
  context, `defaultPreload: "intent"`, and scroll restoration.
- `src/routes/_gallery.tsx:5-9` uses `beforeLoad` and `requireWebSession()` to
  gate the gallery route on the server.
- `src/routes/login.tsx:10-14` uses a server loader with
  `isCurrentWebSessionValid()` to redirect authenticated users.
- `src/routes/_gallery/index.tsx:12-18` uses a route `loader` to prefetch
  `librarySnapshotQueryOptions` on the server.
- `src/routes/manage.tsx:5-9` also uses server `beforeLoad` and
  `requireWebSession()` before rendering management UI.
- `src/features/library/library-service.ts:4,65,119,147` uses
  `createServerFn` for `deleteLibraryEntry`, `getGalleryListing`, and
  `getLibrarySnapshot`.
- `src/features/media/media-delivery-service.ts:31,49,72` uses `createServerFn`
  for thumbnail/media URL resolution.
- `src/features/viewer/viewer-state-service.ts:15,39` uses `createServerFn` and
  imports `@tanstack/react-start/server` inside handlers to read the current request.
- `src/features/management/management-service.ts:53-140` exposes management
  operations through `createServerFn`.
- `docs/ARCHITECTURE.md:75-100` describes Pane View as TanStack Start with
  server functions and HTTP routes.
- `.railway/railway.ts:83-124` deploys Pane View as a single Railway service
  that runs `cd ./apps/pane-view && pnpm start` after `db:migrate`.

## Target Architecture

After this plan, Pane View should have:

- Client-rendered app routes for `/`, `/login`, and `/manage`. Direct browser
  refreshes on those paths should return the app shell and hydrate client-side.
- TanStack Start server functions preserved for browser data/mutations where
  they are already convenient.
- Existing non-UI server endpoints preserved: `/api/auth/*`, `/api/sync/*`,
  `/api/media/*`, `/cdn/v1/*`, and `/internal/optimizer/*`.
- UI routes should not import server-only auth helpers directly in `beforeLoad`
  or loaders. Route auth redirects should be client-owned, usually through a
  small session/status server function.
- No service worker, web manifest, offline cache, or PWA behavior.

## Commands You Will Need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Pane View tests | `pnpm --filter @latch-works/pane-view test` | exit 0 |
| Pane View typecheck | `pnpm --filter @latch-works/pane-view typecheck` | exit 0 |
| Pane View build | `pnpm --filter @latch-works/pane-view build` | exit 0 |
| Workspace check | `pnpm check` | exit 0 |
| Optional smoke | `pnpm dev:pane` then `GET http://127.0.0.1:3000/api/health` | returns `{"ok":true,"service":"pane-view"}` |

## Scope

**In scope**:
- `apps/pane-view/src/routes/_gallery.tsx`
- `apps/pane-view/src/routes/_gallery/index.tsx`
- `apps/pane-view/src/routes/login.tsx`
- `apps/pane-view/src/routes/manage.tsx`
- `apps/pane-view/src/server/auth/web-session.ts` or a new feature-level session
  server function
- Existing server-function callers under `apps/pane-view/src/features/*`
- `apps/pane-view/vite.config.ts` only if the official SPA/SSR route setting
  requires config changes
- `docs/ARCHITECTURE.md` if stack/boundary wording changes

**Out of scope**:
- Replacing `createServerFn` with JSON APIs.
- PWA support, service workers, web manifests, or offline caching.
- Rewriting Better Auth.
- Removing the backend service; Pane View still needs server routes for DB, S3,
  auth, sync, CDN token minting, media redirects, and optimizer coordination.
- Moving API routes into a new app/service.
- Changing Lockstep sync API contracts.
- Changing Railway to static-only hosting.

## Git Workflow

- Branch: `advisor/022-pane-view-spa-server-functions`
- Commit message: `Make Pane View UI routes SPA rendered`
- Keep commits staged by boundary: session/auth route behavior, gallery route
  loader behavior, manage/login route behavior, docs.

## Steps

### Step 1: Confirm Route-Level SSR Setting

Use the installed TanStack Start examples as the authority. Confirm that route
objects in this app can set `ssr: false` at the UI route level while preserving
server functions and server route handlers.

Do not remove `@tanstack/react-start`, `nitro`, or the Pane View server runtime.

**Verify**: Add `ssr: false` to one low-risk UI route in a temporary branch or
small commit, then run `pnpm --filter @latch-works/pane-view typecheck` and
`pnpm --filter @latch-works/pane-view build` -> both exit 0.

### Step 2: Add A Client-Callable Session Server Function

Add a small `createServerFn({ method: "GET" })` for browser session status, for
example returning `{ authenticated: boolean }`. It should use the same session
validation as the existing UI gates and should not expose unnecessary user data.

Prefer placing it in a feature/client-safe module, such as
`src/features/auth/session-service.ts`, with server-only imports inside the
handler. Avoid importing `@tanstack/react-start/server` outside a server-function
handler.

**Verify**: `pnpm --filter @latch-works/pane-view test -- auth session` -> tests cover authenticated and unauthenticated responses.

### Step 3: Convert Login Route To Client-Owned Auth Redirect

In `src/routes/login.tsx`, remove the server loader that calls
`isCurrentWebSessionValid()`. Set `ssr: false` for the route if needed. In the
component, call the session server function through React Query or route loader
running in the browser. If authenticated, navigate to `/`; otherwise show the
existing login form.

Keep the form action `/api/auth/login` and POST behavior unchanged.

**Verify**: `pnpm --filter @latch-works/pane-view test -- login auth` -> tests cover authenticated redirect and unauthenticated form render.

### Step 4: Convert Gallery Shell Route To Client-Owned Auth Redirect

In `src/routes/_gallery.tsx`, remove `beforeLoad` that imports
`requireWebSession`. Set `ssr: false` for the route or parent route as appropriate.
Use the session server function client-side to redirect unauthenticated users to
`/login`.

Keep `GalleryLayout` and existing child route structure intact.

**Verify**: `grep -R "requireWebSession" apps/pane-view/src/routes/_gallery.tsx apps/pane-view/src/routes/manage.tsx` -> no matches after manage is converted in Step 6.

### Step 5: Convert Gallery Index Loader To Browser-Owned Prefetch

In `src/routes/_gallery/index.tsx`, keep `validateSearch` and `loaderDeps` if
they are useful, but make the route `ssr: false` so its loader runs in the
browser. The loader may still call `context.queryClient.ensureQueryData(...)`,
and the query function can still call `getLibrarySnapshot` because it is a
server function with an RPC stub.

If client-side loader prefetch proves fragile, remove the route loader and rely
on `useLibrarySnapshotQuery`/existing pending UI inside `GalleryPage` instead.
Do not replace `getLibrarySnapshot` with a JSON API.

**Verify**: `pnpm --filter @latch-works/pane-view test -- library gallery` -> exits 0.

### Step 6: Convert Management Route To Client-Owned Auth Redirect

In `src/routes/manage.tsx`, remove server `beforeLoad` and set `ssr: false` if
needed. Gate the rendered `ManagementPage` behind the same client session check.
Keep existing management server functions and `management-queries.ts` intact.

**Verify**: `pnpm --filter @latch-works/pane-view test -- management` -> exits 0.

### Step 7: Confirm Server Functions Still Work From SPA Routes

Run or add tests showing the following still call server functions successfully
from client-rendered routes:

- `getLibrarySnapshot` and `getGalleryListing`
- `resolveMediaDeliveryUrl` / `resolveMediaDeliveryUrls`
- viewer state get/save
- management overview/history and one mutation

Static imports of server functions should remain. Avoid dynamic imports of server
functions from client code; installed docs warn those can cause bundler issues.

**Verify**: `grep -R "createServerFn" apps/pane-view/src/features` -> existing
feature server functions remain; `pnpm --filter @latch-works/pane-view build` -> exits 0.

### Step 8: Preserve API/Media/Internal Routes And Refresh Behavior

Confirm direct refresh of `/`, `/login`, and `/manage` returns the app shell and
hydrates. Confirm `/api/health`, `/api/sync/snapshot`, `/api/media/:id/*`,
`/cdn/v1/*`, and `/internal/optimizer/*` still route to their server handlers and
do not fall through to the app shell.

If a route-level `ssr: false` setting is enough, do not add a custom catch-all
fallback. If a fallback is required, ensure it excludes `/api/*`, `/cdn/*`, and
`/internal/*`.

**Verify**: `pnpm --filter @latch-works/pane-view build` -> exits 0, and local
smoke checks confirm HTML for UI refreshes and JSON/status responses for APIs.

### Step 9: Update Docs

Update `docs/ARCHITECTURE.md` to clarify Pane View is a client-rendered SPA UI
using TanStack Start server functions and server routes. Do not claim Pane View
is static-only.

**Verify**: `pnpm --filter @latch-works/pane-view typecheck && pnpm --filter @latch-works/pane-view build` -> exits 0.

## Test Plan

- Session server function tests for authenticated and unauthenticated responses.
- Route/component tests for unauthenticated client redirect from gallery/manage
  to login and authenticated redirect from login to gallery.
- Existing library, media delivery, viewer state, and management server-function
  tests continue to pass.
- Verification: `pnpm --filter @latch-works/pane-view test`,
  `pnpm --filter @latch-works/pane-view typecheck`,
  `pnpm --filter @latch-works/pane-view build`, then `pnpm check`.

## Done Criteria

- [ ] UI routes `/`, `/login`, and `/manage` are client-rendered/SPA-style.
- [ ] Server functions remain the browser data/mutation mechanism.
- [ ] UI routes no longer use server-side `beforeLoad`/loaders that import
  server-only auth modules directly.
- [ ] Existing `/api/sync/*`, `/api/media/*`, `/cdn/v1/*`, and
  `/internal/optimizer/*` routes still work.
- [ ] Direct refresh of UI routes returns a usable app shell.
- [ ] API/server route misses are not swallowed by an SPA fallback.
- [ ] No service worker, manifest, or PWA cache added.
- [ ] Pane View tests, typecheck, build, and full `pnpm check` exit 0.
- [ ] `docs/ARCHITECTURE.md` reflects the new UI/server-function boundary.
- [ ] `plans/README.md` status row updated.

## STOP Conditions

- The installed TanStack Start version cannot use `ssr: false` for these routes
  while preserving server functions.
- The change requires removing `createServerFn` or replacing server functions
  with JSON APIs.
- Removing server route guards creates an unauthenticated flash of private data
  before the client session check finishes.
- API fallback starts returning HTML for `/api/*`, `/cdn/v1/*`, or
  `/internal/optimizer/*` failures.
- The change requires PWA/offline caching; that is explicitly out of scope.

## Maintenance Notes

- Server functions are still server code. Keep DB/S3/auth imports inside
  server-function handlers or server-only modules.
- Reviewers should scrutinize auth UX: client-rendered routes must show a safe
  pending/blank state until session status is known, not private library data.
- This plan deliberately keeps TanStack Start and server functions because they
  are more convenient than hand-written JSON APIs for this app.
