# Plan 039: Reconcile documentation with the Shutter architecture

> **Executor instructions**: Treat source code, package scripts, `docs/ARCHITECTURE.md`, and
> `CONTEXT.md` terminology as the evidence hierarchy. Do not preserve a documented claim merely
> because several documents repeat it. Run every gate and update the plan index.
>
> **Drift check (run first)**: `git diff --stat 06b5005..HEAD -- README.md CONTEXT.md docs apps/*/README.md apps/showcase/src/content/docs package.json`

## Status

- **Status**: DONE (`953e7b2`, independently verified 2026-07-13; root lint retains unrelated
  baseline failures)
- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs / DX
- **Planned at**: commit `06b5005`, 2026-07-13 (drift check refreshed after advisor plans were added)
- **Original finding**: 22

## Why this matters

The onboarding path describes removed packages and files, obsolete CLI syntax, and a retired
Pane-owned derivative pipeline. The Showcase also promises PDF reading in Frame View although Frame
currently indexes only images and videos. These contradictions send contributors toward missing
code and can cause operators to configure the wrong delivery model.

## Current state

- Root `README.md:79-96` lists removed `media-delivery`/`ARCHITECTURE_PLAN.md` paths and says Pane
  bundles ffmpeg for thumbnails; `README.md:140-148` uses the unsupported
  `pnpm start:lockstep -- <command>` form.
- `apps/pane-view/README.md:30,102,130` repeats the retired media stack, bad CLI invocation, and a
  missing architecture link.
- `docs/localhost/latch-works.env.example` carries `MEDIA_DELIVERY_SECRET` but omits the required
  Shutter variables validated by `apps/pane-view/src/env/server.ts`.
- `CONTEXT.md:36` still says Pane owns derivative queue state, while `docs/ARCHITECTURE.md` makes
  Shutter the only rendition provider.
- `docs/next-recommendations.md` proposes Pane-side PDF derivatives and prewarming against deleted
  services and documents.
- `apps/frame-view/README.md:56` names a nonexistent `ensure-electron` script, and
  `apps/lockstep/README.md:109` says repair runs on postinstall although the package uses prestart.
- Showcase Frame documentation promises a dedicated PDF reader; current Frame contracts and catalog
  accept only image/video. Preserve this as an explicitly planned capability linked to Plan 040,
  not as shipped behavior.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Discover broken local links | `rg -n '\]\((\.\.?/|/)' README.md CONTEXT.md docs apps/*/README.md apps/showcase/src/content/docs` | inventory reviewed |
| Check docs contract | `pnpm docs:check` | exit 0, no broken links/env/script claims |
| Repository lint | `pnpm lint` | exit 0 after Plan 024 |

## Scope

**In scope**: root `AGENTS.md` and root/app READMEs; `CONTEXT.md`; current
architecture/recommendation/runbook docs; Showcase claims about Frame; localhost environment example;
a small deterministic documentation contract checker and root script if needed.

**Out of scope**: changing the Shutter architecture; relaxing server environment validation;
implementing Frame PDF support; restoring deleted derivative packages; rewriting historical ADRs;
documenting secrets or real service tokens.

## Git workflow

- Branch: `codex/039-reconcile-shutter-docs`
- Commit message: `Reconcile documentation with Shutter architecture`

## Steps

### Step 1: Build a source-backed claim inventory

Compare every setup command, workspace path, environment key, and runtime capability in the scoped
documents with the relevant `package.json`, workspace manifest, Zod environment schema, and current
source. Classify historical decision records as historical instead of silently rewriting their
context. Record intentionally future capabilities separately from shipped capabilities.

**Verify**: the PR description includes a compact claim -> authoritative source table and identifies
all removed targets before editing prose.

### Step 2: Repair root and app onboarding

Update repository trees, app summaries, prerequisites, dev/build commands, and cross-links. Use the
supported Lockstep syntax from `AGENTS.md`:
`pnpm --filter @latch-works/lockstep start plan --source <path>` or the direct `tsx` form, without an
extra `--`. Make Frame and Lockstep Electron-repair text match their actual scripts.

Describe Pane delivery as signed Shutter rendition/source URLs. Do not reintroduce the retired
derivative queue, media-delivery package, ffmpeg thumbnail pipeline, or missing architecture-plan
document.

**Verify**: every documented command maps to an existing package script or is explicitly labeled as
a shell prerequisite; every relative Markdown link resolves.

### Step 3: Align environment and architecture language

Make the localhost example contain the complete non-secret key set required by
`apps/pane-view/src/env/server.ts`, using unmistakable placeholders for tokens. Remove retired
delivery keys only after confirming no current source reads them. Update `CONTEXT.md` and active
recommendations to use Source Object and Shutter Rendition consistently.

Retire or rewrite recommendations that depend on deleted Pane derivative services. Preserve valid
product ideas such as favorites or PWA work only when their evidence still exists.

**Verify**: a key-set comparison reports no required server variables missing from the localhost
example and no removed variable claimed as active.

### Step 4: Separate shipped behavior from direction

Change Frame PDF wording in the Showcase and root README to either “planned” with a link to the
direction record produced by Plan 040, or remove the claim until that plan lands. Keep Pane PDF
support and Gather Box PDF collection described accurately; they are separate capabilities.

**Verify**: a repository search for Frame + PDF finds no unqualified statement that Frame can open
PDFs before implementation exists.

### Step 5: Add a narrow documentation contract check

Add `scripts/check-docs.mjs` (or the repository's established equivalent) and a root `docs:check`
script. At minimum, check repository-relative Markdown links, selected documented package scripts,
and parity between the localhost example keys and Pane's required server keys. Keep the parser
small and deterministic; if robust env-schema parsing would duplicate Zod semantics, maintain an
explicit allowlisted contract with a test and a comment pointing to the schema.

**Verify**: demonstrate the checker failing on one temporary broken fixture in its test, then passing
the repository. It must not follow external URLs or require network access.

## Test plan

Add focused tests for the checker if it has parsing logic. Run `pnpm docs:check` from a clean checkout,
then run root lint after Plan 024. Manually execute or dry-run every changed command and review the
rendered root README plus changed Showcase pages for broken navigation.

## Done criteria

- [ ] No active document references removed packages/files or the retired Pane derivative stack.
- [ ] Lockstep, Frame, and Pane setup instructions match current scripts.
- [ ] Localhost environment documentation covers every required Pane server key without secrets.
- [ ] Shipped versus planned Frame PDF support is unambiguous.
- [ ] Repository-relative links and selected docs contracts have an automated offline check.
- [ ] `pnpm docs:check` and root lint pass.

## STOP conditions

- Current source and `docs/ARCHITECTURE.md` disagree about which service owns renditions.
- A proposed example would require committing a usable token, credential, or private endpoint.
- Making a command truthful requires changing runtime behavior rather than documentation.
- The checker would need to execute examples with destructive sync/storage actions.

## Maintenance notes

Run `pnpm docs:check` in CI once it is stable. Any product page that describes an unshipped feature
must link to a status-bearing direction/design record rather than presenting it as current behavior.
