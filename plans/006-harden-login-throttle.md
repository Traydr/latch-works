# Plan 006: Harden Pane View Login Throttling

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving to the next step. If any
> STOP condition occurs, stop and report instead of improvising. When done,
> update this plan's row in `plans/README.md` unless a reviewer says they own the
> index.
>
> **Drift check (run first)**:
> `git diff --stat 326110f..HEAD -- apps/pane-view/src/routes/api.auth.login.ts apps/pane-view/src/server/auth/login-throttle.ts apps/pane-view/src/env/server.ts apps/pane-view/src/server/auth/*.test.ts apps/pane-view/src/routes/*.test.ts`
> If any in-scope file changed, compare the excerpts below with the live code
> before proceeding. A mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `326110f`, 2026-06-12

## Why this matters

The login throttle key is based on username plus an IP derived from request
headers. The route trusts `x-forwarded-for` before any proxy-trust decision, so a
client that can set that header can rotate the throttle key. The throttle also
has no username-only bucket, so distributed attempts across many IPs are not
bounded. This plan makes the login throttle harder to bypass while keeping the
single-owner private-site flow simple.

## Current state

- `apps/pane-view/src/routes/api.auth.login.ts` owns the login POST handler and
  `resolveClientIp`.
- `apps/pane-view/src/server/auth/login-throttle.ts` keeps in-memory failure
  counters.
- `apps/pane-view/src/env/server.ts` currently has no trusted-proxy setting.

Relevant excerpts at `326110f`:

```ts
// apps/pane-view/src/routes/api.auth.login.ts:20-35
const clientIp = resolveClientIp(request);

if (isLoginThrottled(clientIp, username)) {
  return new Response(null, { headers: { Location: "/login?error=invalid" }, status: 303 });
}
...
if (!owner) {
  recordFailedLogin(clientIp, username);
  return new Response(null, { headers: { Location: "/login?error=invalid" }, status: 303 });
}
```

```ts
// apps/pane-view/src/routes/api.auth.login.ts:109-116
function resolveClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() || "unknown";
  }

  return request.headers.get("x-real-ip") ?? "unknown";
}
```

```ts
// apps/pane-view/src/server/auth/login-throttle.ts:1-16
const MAX_FAILED_ATTEMPTS = 5;
const WINDOW_MS = 5 * 60 * 1000;
const attemptsByKey = new Map<string, AttemptRecord>();

function throttleKey(ip: string, username: string): string {
  return `${ip}:${username.trim().toLowerCase()}`;
}
```

Repo conventions to match:

- Auth route redirects with `303` and does not reveal whether username or
  password failed.
- Env validation uses `@t3-oss/env-core` plus Zod in `apps/pane-view/src/env/server.ts`.
- Tests should use Vitest and reset in-memory throttle state between cases.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Auth tests | `pnpm --filter @latch-works/pane-view test -- src/server/auth src/routes/api.auth.login` | exit 0, all focused tests pass |
| Pane typecheck | `pnpm --filter @latch-works/pane-view typecheck` | exit 0, no TypeScript errors |
| Pane tests | `pnpm --filter @latch-works/pane-view test` | exit 0, all Pane View tests pass |

## Scope

**In scope**:

- `apps/pane-view/src/routes/api.auth.login.ts`
- `apps/pane-view/src/server/auth/login-throttle.ts`
- `apps/pane-view/src/env/server.ts`, only if a proxy-trust env setting is needed
- Focused auth/login tests
- `plans/README.md`, status row only

**Out of scope**:

- Replacing Better Auth.
- Adding persistent Redis/database throttling.
- Changing login page UI.
- Adding CAPTCHAs or email workflows.

## Git workflow

- Branch: `codex/006-harden-login-throttle`
- Commit style: short imperative summary, for example
  `Harden Pane View login throttling.`
- Do not push or open a PR unless the operator asks.

## Steps

### Step 1: Make client-IP resolution explicit

Replace unconditional trust in `x-forwarded-for` with an explicit policy.

Recommended minimal approach:

- Add a server env setting such as `PANE_VIEW_TRUST_PROXY_HEADERS` with a safe
  default of `false`.
- When false, do not use `x-forwarded-for`; use a stable fallback such as
  `x-real-ip` only if the deployment platform guarantees it, otherwise
  `"unknown"`.
- When true, parse `x-forwarded-for` defensively and use the first non-empty
  address.

If the project already has a deployment-specific header such as
`cf-connecting-ip` or `fly-client-ip`, prefer that documented trusted header
over generic spoofable forwarding headers.

**Verify**:
`pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

### Step 2: Add a username-only throttle bucket

Update `login-throttle.ts` so throttling checks both:

- a per-client bucket, equivalent to the current `ip + username` behavior
- a username-only bucket, normalized the same way

Recording a failed login should increment both buckets. Clearing after a
successful login should clear both buckets for that user and client. Keep the
same window unless tests reveal a better constant already documented elsewhere.

Do not change the external response shape; throttled requests should continue to
redirect to `/login?error=invalid`.

**Verify**:
`pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

### Step 3: Add tests for spoofing and distributed attempts

Add focused tests for `login-throttle.ts` and, if practical, `resolveClientIp`.
Export `resolveClientIp` only if a private helper test pattern already exists;
otherwise test through the route or extract a tiny auth helper module.

Cover at least:

- Different `x-forwarded-for` values do not bypass throttling when proxy trust is
  disabled.
- The same username becomes throttled after failures from multiple IPs.
- A successful login clears both relevant buckets.
- Window expiry still resets throttling.

**Verify**:
`pnpm --filter @latch-works/pane-view test -- src/server/auth src/routes/api.auth.login`
-> exit 0.

### Step 4: Document env behavior if a setting was added

If you add a new env var, update the Pane View env documentation or example env
file if one exists. Do not include real secrets or deployment-specific values.

**Verify**:
`rg "PANE_VIEW_TRUST_PROXY_HEADERS|trust proxy|forwarded" apps/pane-view docs .env.example`
-> output includes the new setting or docs if added.

## Test plan

- Unit tests for `login-throttle.ts`.
- Route/helper tests for client-IP resolution if the route can be tested without
  Better Auth integration overhead.
- Keep in-memory state reset through `resetLoginThrottleForTests`.

## Done criteria

- [ ] Login throttling no longer trusts spoofable forwarding headers by default.
- [ ] Username-only throttling limits distributed attempts against one account.
- [ ] Login failure responses remain generic.
- [ ] Focused auth tests and Pane View typecheck pass.
- [ ] Any new env setting is documented without secrets.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

Stop and report if:

- Deployment docs prove `x-forwarded-for` is sanitized by the only production
  proxy and a new env setting would be misleading.
- Testing the route requires a live Better Auth database.
- Adding a username-only bucket creates lockout behavior that product explicitly
  rejects.

## Maintenance notes

This is still process-local throttling. If Pane View scales to multiple app
instances, move the same bucket semantics to a shared store rather than relying
on per-process Maps.
