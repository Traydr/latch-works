# Plan 043: Isolate Gather Output adapters and enforce artifact budgets

> **Executor instructions**: Preserve the depth of the generated-story PDF module while removing it
> from ordinary UI/image paths. Record before/after metafiles and package measurements. Run every
> gate and update the plan index.
>
> **Drift check (run first)**: `git diff --stat 92b98cb..HEAD -- apps/gather-box docs/adr/0001-gather-box-run-architecture.md docs/plans/041-own-gather-runs-outside-ui.md`

## Status

- **Status**: TODO
- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 041
- **Category**: architecture / performance / build
- **Planned at**: commit `92b98cb`, 2026-07-15
- **Architecture decision**: ADR 0001

## Why this matters

Each current popup/side-panel output is about 2.27 MB. Metafile analysis attributes 2.19 MB (96.5%)
of each to dependencies reachable only through generated story PDFs. `@libpdf/core`, PKI, pako, and
ASN.1 code is statically imported into every full UI. The same graph is duplicated, and minification
alone still leaves a roughly 999 KB UI output.

The full `dist` directory measured 7.86 MB at planning time. Four Noto Serif font files contribute
2.59 MB, and two copied-but-unreferenced source icons contribute about 598 KB. The warning is a real
deployment-seam problem, not just esbuild's display threshold.

## Current state

- `src/popup/fanfiction-story.ts` statically imports `@libpdf/core`.
- `src/shared/gather-controller.ts` statically imports that story module before branching on
  `outputKind`.
- `scripts/build.mjs` forces all contexts through one IIFE build with no splitting or minification.
- The build copies the entire assets directory and emits no metafile or budget check.
- `package.json` and `manifest.json` carry different versions.
- The story-PDF implementation has no focused tests despite its 478 lines and heavy dependency graph.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Tests | `pnpm --filter @latch-works/gather-box test` | output-adapter tests pass |
| Build | `pnpm --filter @latch-works/gather-box build` | minified context-aware artifacts emitted |
| Check | `pnpm --filter @latch-works/gather-box check` | tests plus size budgets pass |
| Measurement | project-provided metafile analyzer | before/after table generated deterministically |

## Scope

**In scope**: a deep Gather Output module; source-file and generated-story adapters; lazy local PDF
loading in the offscreen executor; context-aware esbuild configuration; ESM splitting where Chrome
supports it; release minification; explicit asset copying; version consistency; metafiles and size
budgets; focused story/output tests.

**Out of scope**: changing PDF typography or supported story markup; reducing Unicode coverage by
font subsetting without a separate evidence-backed decision; replacing `@libpdf/core`; changing
collector behavior; source-catalog consolidation (Plan 044); collector injection (Plan 045).

## Git workflow

- Branch: `codex/043-isolate-gather-output-builds`
- Commit message: `Isolate Gather Box output adapters`

## Steps

### Step 1: Capture reproducible artifact baselines

Extend the build tooling to emit an esbuild metafile for each Chrome execution context and a compact
machine-readable summary. Record raw and compressed totals for service worker, side panel,
offscreen base, generated-story chunk, content scripts, fonts, icons, and total `dist`.

Retain the planning measurements as comparison, but regenerate them after Plans 041/042 drift. Do not
set budgets from stale numbers.

**Verify**: deleting/rebuilding `dist` yields the same categorized report; the analyzer attributes
the PDF graph to the generated-story adapter and reports referenced versus copied assets.

### Step 2: Make Gather Output a real adapter seam

Keep one orchestration path for destination, progress, terminal state, cancellation, and diagnostics.
Select between a source-file batch adapter and generated-story PDF adapter based on validated
`outputKind`. Keep output-specific implementation behind that seam and reject unknown kinds.

The generated-story adapter remains deep: chapter fetch, DOM extraction, layout, font loading, PDF
generation, and collision-safe save stay together. Add focused tests for chapter failure, markup
normalization, page wrapping, font/style selection, generated filename, cancellation, and write
failure using synthetic inputs.

**Verify**: run tests select either adapter through the same Gather Output interface; output-specific
failure does not leak UI or service-worker details.

### Step 3: Lazy-load generated story implementation

Replace the static generated-story import with a local dynamic import reached only when
`outputKind === "generated-story-pdf"`. The dynamic chunk runs only inside the offscreen execution
document and complies with MV3's local-code requirement. Ordinary image/file Gather Runs and side
panel startup must not fetch or parse that chunk.

Use a deterministic chunk name and handle import failure as a terminal output error with diagnostics.
Do not fetch code from a CDN or weaken extension CSP.

**Verify**: metafile and browser network/devtools evidence show the PDF chunk absent from side-panel
startup and image Gather Runs, then loaded once for a generated story run.

### Step 4: Split builds by Chrome execution context

Replace the single flat build invocation with explicit context builds:

- extension pages/offscreen: local ESM output with splitting and shared chunks;
- service worker: module output declared consistently in the manifest;
- content/page-key and selected collector entries: self-contained formats valid for content
  injection without web-accessible shared chunks;
- options: extension-page output sharing only dependencies that improve total artifact size.

Minify release builds and keep a debuggable development mode. Make sourcemap policy explicit; do not
ship source maps accidentally. Clean `dist` before every build and fail on missing expected entries.

**Verify**: load the unpacked release build, exercise every context, and assert no CSP, module
resolution, dynamic-import, or service-worker registration error.

### Step 5: Package only declared assets and synchronize versions

Replace recursive asset copying with an explicit packaged-resource list or generated manifest asset
set. Ship only manifest icons, fonts actually referenced by the story adapter, styles/HTML, rules,
and expected script outputs. Exclude unreferenced design/source icons from `dist`.

Choose one authoritative version source and assert `package.json` and emitted manifest agree. Keep
font licensing material with packaged fonts. Do not subset or remove font coverage based only on
size; record that as a separate future opportunity if measurements justify it.

**Verify**: artifact test fails on undeclared/missing files, unused source icons are absent, license
file remains, and version mismatch fails `check`.

### Step 6: Enforce budgets

Set budgets from post-refactor measurements with explicit headroom. At minimum budget side-panel JS,
offscreen base JS, service-worker JS, each content/collector entry, generated-story chunk, total JS,
and total `dist`. Fail with the largest contributing inputs when a budget is exceeded.

Recommended target ranges to validate, not blindly copy:

- side-panel entry plus eagerly loaded shared JS: under 150 KB raw minified;
- offscreen base before PDF: under 150 KB raw minified;
- service worker: under 150 KB raw minified;
- each always-on content entry: under 20 KB raw minified;
- total packaged extension: under 5 MB while retaining current fonts.

If actual necessary code cannot meet a proposed number, record evidence and adjust the budget in
review rather than disabling the gate.

**Verify**: a synthetic oversized import makes `check` fail with actionable attribution; clean build
passes and records the final baseline in this plan.

## Test plan

Cover output selection, unknown output, generated-story happy/failure/cancellation paths, dynamic
import failure, context module loading, CSP/local-code compliance, artifact inventory, version
consistency, clean-build determinism, and every size budget. Smoke both image and story Gather Runs
through the Plan 041 browser harness.

## Done criteria

- [ ] PDF dependencies are absent from side-panel startup and ordinary source-file Gather Runs.
- [ ] Generated-story code loads locally and only for its output kind.
- [ ] Source-file and generated-story adapters share one tested Gather Output seam.
- [ ] Build topology matches Chrome contexts and release output is minified.
- [ ] Recursive unused-asset copying and package/manifest version drift are gone.
- [ ] Metafile attribution and artifact budgets run in `check`.
- [ ] Gather tests, unpacked Chrome smoke, and build pass without size warnings on ordinary entries.

## STOP conditions

- Dynamic local import requires weakening MV3 CSP or exposing extension chunks to untrusted pages.
- ESM splitting breaks service-worker, offscreen, or extension-page registration on the supported
  Chrome baseline.
- Removing an asset would reduce generated PDF character/style support.
- A budget can be met only by hiding code from analysis or excluding required release artifacts.

## Maintenance notes

Review metafile deltas on dependency upgrades. Keep heavy optional implementations aligned with
their runtime seam, and require a recorded reason whenever ordinary UI startup gains a new dependency
larger than its existing local source graph.
