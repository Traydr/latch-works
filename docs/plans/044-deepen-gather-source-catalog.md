# Plan 044: Deepen the Gather Source catalog

> **Executor instructions**: Consolidate source knowledge without flattening per-source collector
> implementation. Manifest output must remain inspectable and deterministic. Run every gate and
> update the plan index.
>
> **Drift check (run first)**: `git diff --stat 92b98cb..HEAD -- apps/gather-box docs/gather-box-sidecar-manifests.md CONTEXT.md docs/adr/0001-gather-box-run-architecture.md`

## Status

- **Status**: TODO
- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 043
- **Category**: architecture / security / developer experience
- **Planned at**: commit `92b98cb`, 2026-07-15
- **Architecture decision**: ADR 0001

## Why this matters

A Gather Source is currently represented independently in TypeScript URL regexes, manifest host
permissions, content-script matches, context-menu document patterns, a hostname/path dispatch chain,
credential defaults, download-origin policy, and save-behavior presentation. Adding or changing one
source requires synchronized edits across at least six modules.

Drift already exists: X and pixiv content scripts match broader pages than runtime eligibility;
pixiv URL variants differ across representations; download policy accepts a MyHentaiGallery host
variant not represented by source detection/permissions. This makes least-privilege review and
source additions unreliable.

## Current state

- `src/shared/sites.ts` owns `SiteKey`, labels, and runtime regexes.
- `manifest.json` separately owns host permissions and content-script matches.
- `src/background/index.ts` copies document patterns into context-menu creation.
- `src/content/index.ts` repeats hostname/path dispatch for eight collectors.
- `src/shared/credentials.ts`, `download-policy.ts`, and `save-behavior.ts` repeat source cases.
- Options and README tables consume only selected portions of this knowledge.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Tests | `pnpm --filter @latch-works/gather-box test` | catalog and source tests pass |
| Build | `pnpm --filter @latch-works/gather-box build` | deterministic manifest emitted |
| Check | `pnpm --filter @latch-works/gather-box check` | consistency/permission gates pass |

## Scope

**In scope**: one authoritative Gather Source catalog; stable source keys; eligible URL matching;
Chrome match/document patterns; page/download origins; collector adapter identity; credential
defaults; save behavior; deterministic manifest generation; context menu and options derivation;
consistency/security tests; docs synchronization.

**Out of scope**: changing per-source DOM extraction; making every host permission optional; adding
new Gather Sources; implementing sidecar manifests; renaming stable `SiteKey` values without a
migration; on-demand injection mechanics (Plan 045).

## Git workflow

- Branch: `codex/044-deepen-gather-source-catalog`
- Commit message: `Deepen the Gather Source catalog`

## Steps

### Step 1: Inventory every source fact and consumer

For each existing Gather Source, enumerate page eligibility, page match patterns, fetch origins,
referer/network-rule requirements, collector adapter, output kinds, credential default, archive save
behavior, context-menu eligibility, and user-facing label. Compare the inventory with the current
manifest and runtime behavior; classify every mismatch as a bug to fix or intentional breadth to
document.

Do not assume a broad host pattern is required because it already exists. Conversely, do not narrow
download origins without testing redirects and CDN behavior for synthetic or safe real examples.

**Verify**: commit a source matrix in the plan or a focused architecture document and resolve every
current mismatch before defining generated output.

### Step 2: Create one deep catalog

Define one catalog record per stable `SiteKey`. Keep declarative source policy together while
retaining collector extraction in per-source modules. The catalog must provide enough depth that
runtime consumers ask source-level questions rather than repeating hostname switches.

Represent Chrome match patterns and runtime URL eligibility separately when their semantics differ,
but colocate them and test their relationship. Normalize URLs before matching where safe. Reject
unknown source keys read from persisted settings rather than casting arbitrary strings into the
catalog.

**Verify**: tests cover all documented eligible and ineligible URL forms, unique keys/labels,
complete save/credential/output data, and sanitized persisted settings.

### Step 3: Generate the manifest through the build adapter

Use the context-aware build established in Plan 043 to emit `dist/manifest.json` from a small base
manifest plus catalog-derived host permissions, page-key content matches, and related source rules.
Keep the emitted manifest formatted and stable so reviewers can inspect permission changes in build
diffs or snapshots.

The source manifest input must no longer contain a second hand-maintained list of the same source
hosts. Validate Chrome match-pattern syntax and prevent a source from gaining `http`, wildcard
schemes, or broad all-host access accidentally.

Maintain currently required permissions for this plan. A future optional-host migration needs a
separate UX/security decision because first-use permission prompts affect shortcut semantics.

**Verify**: manifest snapshot tests cover every source and fail on catalog/manifest drift; the
unpacked extension loads without manifest warnings.

### Step 4: Derive runtime consumers

Replace copied context-menu patterns, source lookup regex loops, credential switches, download
allowlists, save-behavior tables, and user-facing source lists with catalog queries or explicit
adapters over the catalog. Preserve the two-adapter principle: build generation and runtime lookup
are distinct consumers of the same deep module.

Do not let the catalog become a bag of callbacks that hides collector implementation. Collector
modules should remain named, source-specific adapters selected by catalog identity.

**Verify**: deletion test passes—the old tables/switches are removed and their complexity is
concentrated rather than copied into new modules; focused tests exercise each derived consumer.

### Step 5: Add permission and source-consistency gates

Add checks that every eligible page is covered by the intended page access, every declared fetch
origin is justified by a collector/output path, every context-menu pattern is a subset of eligible
pages, every save behavior has a source, and every source selects an existing collector entry.

Generate a concise permission report in CI/build output showing each host pattern and its Gather
Source/reason. Fail if a host permission has no owner.

**Verify**: deliberately adding an orphan permission, missing collector, over-broad match, or source
without save behavior makes `check` fail with the responsible source named.

### Step 6: Synchronize documentation

Update Gather Box README and any Showcase supported-source material from or against the same catalog.
Avoid runtime CDN generation; generated docs may be checked snapshots or consistency tests. Keep the
sidecar design's site values aligned without claiming sidecars are implemented.

**Verify**: source list/name drift between extension docs, sidecar design, and catalog fails a
focused check or is documented as intentionally different.

## Test plan

Cover URL normalization and eligibility per source, match-pattern relationships, host ownership,
context-menu subsets, credential/save/output completeness, persisted-key sanitation, deterministic
manifest output, permission report, missing collector artifacts, and user-facing source lists.

## Done criteria

- [ ] One catalog is authoritative for every Gather Source policy fact in scope.
- [ ] Manifest permissions/content matches are generated and reviewable.
- [ ] Context-menu, lookup, credentials, download policy, save behavior, and options no longer repeat
      source switches/tables.
- [ ] Every host permission has a named source and reason.
- [ ] Existing eligible URL behavior is preserved or drift fixes are explicitly recorded.
- [ ] Source/catalog/manifest/docs consistency tests and Gather check pass.

## STOP conditions

- Manifest generation obscures permission diffs or makes the unpacked artifact non-deterministic.
- A source requires runtime behavior that cannot be represented without moving its full collector
  implementation into the catalog.
- Narrowing a host pattern breaks a required CDN/redirect flow without a safe replacement.
- Optional-host permissions are required to complete consolidation; split that UX change into a new
  decision instead.

## Maintenance notes

Adding a Gather Source must begin in the catalog and include URL, permission, collector, output,
credential, save, documentation, and test evidence in one review. Avoid recreating source switches
outside the catalog adapters.
