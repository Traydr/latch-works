# Documentation Audit

**Date:** 2026-06-12  
**Scope:** All documentation in `docs/` and `apps/frame-view/docs/`

---

## Executive summary

Operational runbooks (`pane-view-thumbnails`, `railway-cdn-pane-view`, `lockstep` README) are largely accurate. Planning and analysis docs from early June 2026 lag significant implementation progress (settings drawer, comic/PDF readers, mobile tap, recursive browsing). `ARCHITECTURE_PLAN.md` remains a pre-implementation vision document with many unbuilt features. A consistent **CLI invocation mismatch** (`pnpm lockstep` vs `pnpm start:lockstep`) appears across multiple docs.

---

## Per-file audit

### `docs/ARCHITECTURE_PLAN.md`

| | |
|---|---|
| **Status** | Partially outdated |
| **Purpose** | Pre-implementation architecture vision |

**Inaccuracies:**

- Framed as pre-implementation ("Before writing application code", §24).
- References `C:\Users\Trayd\dev\...` external paths.
- Proposed `docs/architecture/`, `packages/media-ui`, `packages/auth`, `tools/migrate` do not exist.
- Lockstep commands use `--remote production` and `prune` — not implemented.
- §14 mentions `.frame-web-sync-cache.sqlite`, multipart uploads, local ffprobe/sharp in CLI — not built.
- §23 points to `docs/decisions/0001-...` but file is `docs/analysis/0001-phase-0-answers.md`.

**Recommended actions:**

- Mark as historical architecture vision.
- Add "implemented vs planned" section at top.
- Fix decisions link.
- Move unbuilt items to backlog or remove from "current plan".

---

### `docs/end-to-end-request-flow.md`

| | |
|---|---|
| **Status** | Partially outdated |
| **Purpose** | Request flow documentation for gallery and sync |

**Inaccuracies:**

- References `PaneViewHome` and `apps/pane-view/src/routes/index.tsx` — route is now `_gallery/index.tsx` / `GalleryPage.tsx`.
- Gallery thumbnails: doc says tiles use `/api/media/.../original` as fallback; code uses `useResolvedMediaUrl` → `resolveMediaDeliveryUrl` server function, and `buildGalleryThumbnailUrl` returns `/cdn/v1/...` or `/api/media/.../thumbnail`.
- Viewer state "may be incremental" — still unwired in `MediaViewerModal`.
- Lockstep example uses `pnpm lockstep --` (invalid root script).
- "What push does not do" (thumbnails) is still accurate.

**Recommended actions:**

- Update route/file names.
- Document `resolveMediaDeliveryUrl` flow.
- Fix CLI examples to `pnpm start:lockstep` or `pnpm --filter @latch-works/lockstep start`.
- Note viewer-state gap explicitly.

---

### `docs/runbooks/lockstep.md`

| | |
|---|---|
| **Status** | Partially outdated |
| **Purpose** | Lockstep operational runbook |

**Inaccuracies:**

- Examples use `pnpm lockstep --` throughout — root has `start:lockstep`, not `lockstep`.
- `--yes` described as required for scripted push; non-interactive push never prompts, so `--yes` is redundant in CLI mode.
- `--max-changes` docs don't warn that deletes may be skipped (confirmed code bug).
- Interactive section and env vars are accurate.

**Recommended actions:**

- Replace `pnpm lockstep` with `pnpm start:lockstep` (per `AGENTS.md`, no extra `--`).
- Clarify `--yes` only affects interactive wizard.
- Add warning about delete ordering with `--max-changes`.

---

### `docs/runbooks/pane-view-thumbnails.md`

| | |
|---|---|
| **Status** | Current |
| **Purpose** | Thumbnail generation operational guide |

On-demand generation, CDN flow, 503 retry, sharp/ffmpeg split match implementation. "Future: Lockstep pre-warm" is still future.

**Recommended actions:** Keep; optional cross-link to `useResolvedMediaUrl`.

---

### `docs/runbooks/railway-cdn-pane-view.md`

| | |
|---|---|
| **Status** | Current |
| **Purpose** | Railway CDN deployment guide |

CDN enablement, env vars, `x-cache: HIT`, `/api/health` `ffmpegAvailable` align with code.

**Recommended actions:** Keep as operational runbook.

---

### `docs/analysis/0001-phase-0-answers.md`

| | |
|---|---|
| **Status** | Current |
| **Purpose** | Phase 0 architectural decisions |

Decisions still reflected in code (single-user, signed URLs, path preservation, deletes on sync).

**Recommended actions:** Keep; fix inbound link from `ARCHITECTURE_PLAN.md` §23.

---

### `docs/analysis/pane-view-problem-inventory.md`

| | |
|---|---|
| **Status** | Partially outdated |
| **Purpose** | Problem inventory snapshot (2026-06-05) |

Many items addressed: `recursive` default false, server `recursive` scoping, mobile single-tap, `SettingsDrawer`, `ComicReader`, `PdfViewer` exist. Loader still has limits (`limit ?? 5000`).

**Recommended actions:** Add "resolved since" column or archive; use as historical input, not live bug list.

---

### `docs/analysis/pane-view-frame-view-parity-gaps.md`

| | |
|---|---|
| **Status** | Partially outdated |
| **Purpose** | Feature parity comparison |

Summary table says Settings ❌, Comic reader ❌, PDF reader ❌ — all now exist in pane-view. Thumbnail hover autoplay still ❌ (accurate).

**Recommended actions:** Refresh summary table and "Already at parity" section.

---

### `docs/analysis/pane-view-issue-analysis.md`

| | |
|---|---|
| **Status** | Partially outdated |
| **Purpose** | Issue analysis with severity ratings |

M-01 marked Critical/not done; single-tap on mobile is implemented. P-01 partially done. Many ratings still useful for remaining gaps.

**Recommended actions:** Update executive summary counts; mark completed items.

---

### `docs/analysis/pane-view-issue-feedback.md`

| | |
|---|---|
| **Status** | Current (process doc) |
| **Purpose** | Template for human reviewer decisions |

Not meant to mirror code state.

**Recommended actions:** Keep; fill reviewer/date when used.

---

### `docs/analysis/pane-view-issue-clarifications.md`

| | |
|---|---|
| **Status** | Current |
| **Purpose** | Implementation specs for backlog items |

Still valid for unfinished work (e.g. M-07 breadcrumbs).

**Recommended actions:** Keep linked to backlog.

---

### `docs/plans/pane-view-approved-backlog.md`

| | |
|---|---|
| **Status** | Partially outdated |
| **Purpose** | Approved backlog (2026-06-05) |

Several P0 items have partial or full implementation (S-05, P-01, S-01, M-01, M-10 components exist). P-04 partially done.

**Recommended actions:** Re-audit each ID against codebase; update priorities and exit criteria.

---

### `docs/plans/pane-view-phase-7.md`

| | |
|---|---|
| **Status** | Partially outdated |
| **Purpose** | Phase 7 implementation plan |

States "0 of 47 backlog items fully complete" and cites old `index.tsx` — contradicted by `GalleryPage`, `SettingsDrawer`, `ComicReader`, `PdfViewer`, `recursive` plumbing.

**Recommended actions:** Refresh "Current state" section and todo statuses.

---

### `docs/latch-works-brand-kit.md`

| | |
|---|---|
| **Status** | Current |
| **Purpose** | Brand naming and product roles |

Still matches repo layout.

**Recommended actions:** Keep.

---

### `docs/original_prompt.md`

| | |
|---|---|
| **Status** | Obsolete |
| **Purpose** | Historical prompt from empty-repo planning phase |

**Recommended actions:** Archive or move to `docs/history/`; link from README if kept.

---

### `apps/frame-view/docs/feature-specification.md`

| | |
|---|---|
| **Status** | Partially outdated |
| **Purpose** | Frame View v1 feature spec |

Says videos "autoplay and loop in thumbnails" globally; `ai-notes.md` and implementation use hover-only autoplay. "Scan files only when folder opened" vs incremental scan.

**Recommended actions:** Align with `ai-notes.md` or mark as original v1 intent.

---

### `apps/frame-view/docs/screen-breakdown.md`

| | |
|---|---|
| **Status** | Partially outdated |
| **Purpose** | UI component map |

Structural UI map still broadly valid; some components renamed/refactored.

**Recommended actions:** Light refresh after major UI changes; low priority.

---

### `apps/frame-view/docs/ai-notes.md`

| | |
|---|---|
| **Status** | Current |
| **Purpose** | Implementation-aligned technical notes |

Detailed, preferred source of truth for Frame View behavior.

**Recommended actions:** Keep updated per `AGENTS.md`; prune stale bullets periodically.

---

### `apps/frame-view/docs/plans/frame-view-v1-plan.md`

| | |
|---|---|
| **Status** | Obsolete (milestone) |
| **Purpose** | Milestone 1 plan |

Core v1 delivered per `ai-notes.md`.

**Recommended actions:** Mark completed; point to v1.1 plan.

---

### `apps/frame-view/docs/plans/frame-view-v1.1-plan.md`

| | |
|---|---|
| **Status** | Partially outdated |
| **Purpose** | v1.1 cross-platform parity plan |

Some items may have landed.

**Recommended actions:** Review open items against repo; update status.

---

### `apps/frame-view/docs/plans/unified-folder-gallery-plan.md`

| | |
|---|---|
| **Status** | Partially outdated |
| **Purpose** | Unified folder+media grid plan |

`ai-notes.md` indicates unified browsing shipped.

**Recommended actions:** Mark implemented or merge into `ai-notes.md` and archive.

---

### `tools/lockstep/README.md`

| | |
|---|---|
| **Status** | Current |
| **Purpose** | Lockstep CLI reference |

Matches commands, env vars, `start:lockstep` usage. Minor: `--yes` semantics overstated for pure CLI.

**Recommended actions:** Add note on `--max-changes` + delete ordering once code is fixed.

---

### `AGENTS.md` (repo root)

| | |
|---|---|
| **Status** | Current |
| **Purpose** | Agent and contributor guidelines |

Accurate project structure, commands, Cloud-specific service startup, test caveats, media delivery notes.

**Recommended actions:** Keep; add link to `docs/analysis/` code review reports.

---

## Cross-cutting documentation issues

### 1. CLI invocation inconsistency

`docs/runbooks/lockstep.md`, `docs/end-to-end-request-flow.md`, and `ARCHITECTURE_PLAN.md` use `pnpm lockstep`. Repo standard is `pnpm start:lockstep` or `pnpm --filter @latch-works/lockstep start` (`AGENTS.md`, root `package.json`).

### 2. Phase 7 docs lag implementation

Several P0 items (mobile tap, settings shell, comic/PDF readers, recursive default) landed after the 2026-06-05 analysis snapshot. Planning docs should be re-audited against current code.

### 3. Media delivery docs

Any doc telling clients to put `/api/media/...` directly in `<img src>` is outdated. Use `resolveMediaDeliveryUrl` / `useResolvedMediaUrl` (also noted in `AGENTS.md`).

### 4. Missing documentation

| Topic | Gap |
|-------|-----|
| `packages/media-delivery` | No README or architecture doc (package exists but not in AGENTS.md package list) |
| Gather Box | No `docs/` entry; only app-level README |
| Security model | No dedicated threat model or security runbook |
| CI/CD | No CI workflow docs |
| Database schema | No schema documentation beyond Drizzle definitions |

---

## Recommended documentation maintenance plan

### Immediate

1. Fix CLI examples across `lockstep.md`, `end-to-end-request-flow.md`.
2. Add "implemented vs planned" header to `ARCHITECTURE_PLAN.md`.
3. Update `pane-view-frame-view-parity-gaps.md` summary table.

### Short-term

4. Re-audit `pane-view-approved-backlog.md` item statuses.
5. Refresh `pane-view-phase-7.md` current state section.
6. Archive `original_prompt.md` and completed frame-view v1 plan.
7. Add `media-delivery` to `AGENTS.md` package list.

### Ongoing

8. Mark analysis docs with review dates and "resolved since" columns.
9. Keep `ai-notes.md` as frame-view source of truth; deprecate conflicting specs.
10. Link code review reports from `AGENTS.md` and this README.
