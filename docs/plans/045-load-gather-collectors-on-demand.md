# Plan 045: Load only the selected Gather Source collector

> **Executor instructions**: Keep page shortcuts lightweight and preserve source extraction behavior.
> Inject only into the captured main frame after the Gather Source catalog selects an adapter. Run
> every gate and update the plan index.
>
> **Drift check (run first)**: `git diff --stat 92b98cb..HEAD -- apps/gather-box docs/adr/0001-gather-box-run-architecture.md docs/plans/042-make-gather-commands-deterministic.md docs/plans/044-deepen-gather-source-catalog.md`

## Status

- **Status**: DONE
- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 042, Plan 044
- **Category**: architecture / performance / extension hygiene
- **Planned at**: commit `92b98cb`, 2026-07-15
- **Architecture decision**: ADR 0001

## Why this matters

The manifest loads one 48.2 KB `gallery-collector.js` bundle at `document_start` on every matched
page. That bundle imports all eight source collectors even though collection happens only after a
Gather command. The always-on work exists primarily to install two Right Shift page shortcuts.

Page keys and DOM extraction have different lifetimes and form a real seam. A small key adapter may
remain always on; each source collector should enter the exact page only when its Gather Run reaches
collection.

## Current state

- `src/content/index.ts` imports every collector, installs page shortcuts, listens for a generic
  collect message, and dispatches by hostname/path.
- `manifest.json` injects that monolith at `document_start`, with broad X/pixiv matches.
- `src/popup/active-tab.ts` already has a generic missing-receiver injection fallback.
- Only X and pixiv collectors have focused fixture tests; six source adapters have none.
- Reloaded unpacked extensions leave stale page listeners that swallow send failures while still
  intercepting keys.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Tests | `pnpm --filter @latch-works/gather-box test` | collector and page-key tests pass |
| Build | `pnpm --filter @latch-works/gather-box build` | one small key entry plus selected collector entries |
| Check | `pnpm --filter @latch-works/gather-box check` | collector budgets and catalog checks pass |
| Browser smoke | Load `apps/gather-box/dist` in Chrome 145+ | each source collects through its own entry |

## Scope

**In scope**: a dedicated always-on page-key adapter; per-source or evidence-backed shared collector
entries; catalog-selected programmatic injection; exact main-frame targeting; idempotent/reload-safe
registration; collector fixture coverage; content entry size budgets; manual/browser source matrix.

**Out of scope**: removing page shortcuts; changing their approved key combinations; rewriting
collector extraction without a failing fixture; adding sources; optional-host permission migration;
moving X privileged resolution into page context; sidecar manifests.

## Git workflow

- Branch: `codex/045-load-gather-collectors-on-demand`
- Commit message: `Load Gather collectors on demand`

## Steps

### Step 1: Extract the always-on page-key adapter

Build a dedicated content entry that contains only key detection, page-shortcut settings observation,
and semantic command delivery from Plan 042. It must not import source collectors, save behavior,
download logic, PDF code, or broad UI state.

Install it at `document_start` only on catalog-derived eligible page patterns. Preserve the physical
Right Shift behavior, repeat suppression, blur reset, and settings support, but make stale extension
contexts fail visibly/safely: do not keep preventing the page's key after command delivery is known
to be unavailable.

**Verify**: metafile proves no collector enters the key entry; key tests cover installation after
Shift is already held, blur/missed-keyup recovery, editable targets, disabled settings, stale context,
and supported keyboard-layout fallbacks.

### Step 2: Build collector adapters as selected entries

Create injectable collector entries selected by the Gather Source catalog. Prefer one entry per
source when implementation/policies differ. Share a physical entry only when two catalog sources
genuinely use the same collector implementation, not merely to reduce entry count.

Each entry exposes one collection behavior, validates it is running on its own eligible URL, returns
a JSON-serializable Gather Output description, and contains no persistent command listener unless
the injection protocol requires one. Keep privileged X media resolution in the service-worker
adapter and validate its messages against the captured run/tab/source.

**Verify**: metafiles map each collector entry to only its own implementation and allowed shared
helpers; every entry rejects an ineligible URL and returns the expected discriminated output.

### Step 3: Inject the selected collector for the exact Gather Run

At the collecting phase, resolve the source from Plan 044's catalog and inject its collector into the
captured main frame with `chrome.scripting`. Do not query the active tab again. Ensure `activeTab` or
declared source permission is present and return a specific permission/target error when it is not.

Choose one-shot execution or idempotent registration based on measured Chrome behavior. Repeated
Gather Runs on the same SPA/tab must not accumulate listeners or let an old collector answer a new
source URL. Include run/request identity in collection responses and discard mismatches.

**Verify**: tests and browser traces prove only the selected entry is injected, exactly one response
belongs to the current run, and repeated collection/navigation/reload does not duplicate listeners.

### Step 4: Preserve SPA and reload behavior

Exercise X, pixiv, and FANBOX navigation patterns where the document may survive URL changes. The
coordinator must revalidate current tab URL against the captured Gather Source before injection and
the collector must inspect current DOM/location at execution time.

After extension reload, the small page-key adapter may require a page refresh; make that state
non-destructive and diagnosable. A direct native command must still be able to inject the current
collector without relying on the old page-key adapter.

**Verify**: browser tests navigate within each SPA class, reload the unpacked extension, invoke both
page and native commands, and observe either correct collection or an explicit refresh/target error.

### Step 5: Add fixture tests for every collector

Add synthetic, credential-free DOM/response fixtures for MyHentaiGallery, Kemono, FANBOX, AO3,
Hentai Foundry stories, and fanfiction.net to match the existing X/pixiv coverage. Cover selector
absence, malformed URLs, sanitization, ordering, skipped items, folder segments, metadata, and output
kind. Keep live-site smoke checks manual and do not commit private page captures.

Extract shared collector helpers only when at least two source adapters use them and the seam remains
deep. Do not create shallow functions solely to make private call details testable.

**Verify**: each catalog source has a named fixture suite that exercises its collector interface and
at least one failure path.

### Step 6: Enforce content-context budgets and permissions

Apply Plan 043 budgets to the always-on key entry and every collector entry. Emit a build report
showing entry size, imported source modules, manifest matches, and required permissions. Fail if the
key entry gains a collector or if a collector gains another source's implementation.

Confirm content entries execute in the isolated world and no collector asset is made broadly
web-accessible. Keep manifest host access aligned with the catalog and avoid adding all-host access.

**Verify**: deliberate cross-source import and size regression fail `check`; unpacked Chrome reports
no CSP, permission, injection, or missing-chunk errors.

## Test plan

Cover page-key behavior, stale extension contexts, catalog-to-entry selection, exact tab/frame,
ineligible URLs, request identity, repeat injection, SPA navigation, extension reload, permission
failure, one fixture suite per source, output discrimination, content size budgets, isolated-world
execution, and manifest entry presence.

## Done criteria

- [ ] The always-on content bundle contains page-key behavior only and meets its budget.
- [ ] Every Gather Source selects an explicit collector entry.
- [ ] A Gather Run injects only its selected collector into the captured main frame.
- [ ] Repeated runs, SPA navigation, and extension reload cannot produce stale/duplicate responses.
- [ ] All eight collectors have focused synthetic fixture coverage.
- [ ] No collector code is broadly web-accessible or loaded at `document_start`.
- [ ] Gather tests, catalog/build checks, and browser source matrix pass.

## STOP conditions

- A supported site cannot be collected through programmatic isolated-world injection without
  weakening permissions or exposing extension code to the page.
- A site requires persistent document-start observation for collection correctness; document the
  concrete requirement and retain only that source-specific adapter.
- SPA behavior makes one-shot/source-specific injection less reliable than the current monolith
  after retries and exact-target checks.
- Fixture creation would require committing private/authenticated page content.

## Maintenance notes

New Gather Sources must ship a catalog entry, dedicated collector entry or justified shared adapter,
synthetic fixture suite, injection smoke, permission reason, and size evidence. Keep the page-key
adapter source-agnostic.

## Final content-entry baseline

The release metafile gate proves that `content/page-shortcuts.js` imports only shortcut and semantic
message modules. Each collector output imports exactly one source collector module; cross-source
imports fail the build.

| Entry | Raw minified |
|---|---:|
| Always-on page shortcuts | 1.6 KB |
| MyHentaiGallery collector | 2.3 KB |
| Kemono collector | 2.8 KB |
| pixivFANBOX collector | 4.1 KB |
| X collector | 8.6 KB |
| pixiv collector | 3.2 KB |
| Archive of Our Own collector | 2.7 KB |
| Hentai Foundry collector | 2.7 KB |
| FanFiction.Net collector | 3.4 KB |

All entries execute in Chrome's isolated world. No collector is listed under `content_scripts` or
`web_accessible_resources`; the manifest loads only the 1.6 KB page shortcut adapter at
`document_start`.
