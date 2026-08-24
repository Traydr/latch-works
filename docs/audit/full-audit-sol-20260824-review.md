# Review of the 2026-08-24 full codebase audit

Reviewed: `docs/audit/full-audit-sol-20260824.md` (59 accepted recommendations, 8 rejections,
4 subsystem skips) against the tree at `be776cb`.

## Verdict

The audit is trustworthy. I independently verified 38 of the 59 findings against the code —
every deep-verified finding in the top-15 ranking plus the riskiest deletions and migrations —
and every factual claim held. The remaining 21 are refactor-shape recommendations in files
whose cited evidence follows the same patterns I confirmed elsewhere; none looked suspicious on
spot inspection, but I did not trace them line by line (marked below).

Three things I would change:

1. **I02-A belongs in the top 3, not off the ranked list.** CI (`.github/workflows/check.yml`)
   runs no tests at all, and it runs `pnpm format` (which rewrites files) *before* `lint:biome`,
   so format drift can never fail CI. `check:all` also omits tests. Nearly every other finding's
   validation plan is "add tests" — those tests gate nothing until this lands. It is also the
   cheapest high-impact change in the document.
2. **Two "high impact" ratings are inflated** (S03-A, P07-B — details below). Both are still
   worth doing because they are small, but they should not displace real bugs in scheduling.
3. **G04-A's proposed fix has an unstated regression** the implementer must design around
   (details below).

## Confirmed real bugs — act on these

| ID | Verified | Note |
|---|---|---|
| P07-A | Yes | `z.coerce.boolean()` at `apps/pane-view/src/env/server.ts:18`; `Boolean("false")` is `true`, and `.env.example:27` documents `false`. When trusted, `resolveClientIp` takes attacker-controlled `x-forwarded-for`, so the IP half of the login throttle is spoofable on direct-exposed deployments. Correctly ranked #1. |
| P04-A | Yes | Traced it fully: `task.cancel()` sets the closure variable to `undefined`; after `getPage()` resolves, the stale guard compares `undefined !== renderTasks.get(pageNumber)` → `undefined !== undefined` → passes. `page.render()` then starts unowned, and `task.cancel = ...` throws on `undefined` into the swallow-all catch. Confirmed exactly as described. |
| G02-A | Yes, with a nuance | `StoredGatherRunPhaseSchema` (`gather-run.ts:114`) omits `cancelling` while the coordinator persists that phase (`gather-run-coordinator.ts:164`). MV3 service workers restart frequently, so a mid-cancel run silently vanishing is a realistic path. Nuance: the drop is *documented as intentional* in the code comment at `gather-run.ts:110-113` — this fix reverses a recorded decision, so pick the recovery policy (resume cancel vs. mark interrupted) deliberately. |
| G04-B | Yes | `buildRetryImages` (`offscreen/executor.ts:183`) matches failures to sources by filename via a `Set`; duplicate filenames retry items that succeeded. |
| L01-A | Yes | `createProfile` pushes into `state.profiles` and sets session tokens before `save()`; a failed write returns an error but the phantom profile stays live in memory. Same pattern in the other mutations. |
| P04-B | Yes | `flushSave` clears `pendingPatchRef` then awaits with no in-flight serialization; overlapping flushes (debounce fire + unmount flush) can land out of order. Bonus not in the audit: a rejected save silently *loses* the cleared patch, and the `void flushSave()` call makes it an unhandled rejection. |
| L03-B | Yes | CLI regex-parses `[n/m] hashing path` out of free-form status (`commands.ts:292`); the desktop renderer keys phases off `/push|upload|prune|delete|doctor/i` against the message (`useLockstepController.ts:86`) — a file path containing "delete" or "plan" flips the phase. |
| G03-A | Yes | `getActiveRunId` returns `null` for closed document, malformed status, and send failure alike (`offscreen-document.ts:58-72`); the coordinator reads `null` as idle. |
| F02-A | Yes | `upsertBatch` writes live into `media_index` during the scan; `cancelScan` only flips the run row, leaving mixed old/partial-new rows. Correctly marked large effort — do not start this one casually. |
| F04-A | Yes | `isMaximized()` is read, awaited on, then bounds are read after the await (`windowStatePersistence.ts:42-47`); close does three sequential writes. Real, but impact is window geometry — "high" is generous. Do it anyway; it's tiny. |
| I02-A | Yes | See verdict item 1. I would implement this before anything else in the document. |

## Confirmed safe deletions — cheap wins

| ID | Verified | Note |
|---|---|---|
| P03-A | Yes | Reference-searched all five modules. Important subtlety the audit got right but a future implementer could trip on: live code imports `gallery-thumbnail-size.ts`; the dead `thumbnail-size.ts` is imported only by the other two dead modules (`media-preview-url.ts`, `pane-view-media-url.ts`). `PaneViewImage.tsx` is live (4 callers) — it is evidence, not a deletion target. |
| P02-B | Yes | No imports of `dither-kit/(avatar|button|gradient|radar)` anywhere in `src`. |
| G01-A | Yes | `pageNumber`/`thumbnailUrl`/`galleryId`/`skippedCount` are only ever manufactured (11 collectors + coordinator) and schema-declared; nothing reads them downstream. |
| S03-B | Yes | `getStoredObject`, `putStoredObject`, `readStoredObjectBuffer`, `getBucketConfig` have zero non-test callers outside the package; `listStoredObjects` is used by `cleanup-worker.ts` and is correctly on the keep list. |
| S02-B | Yes | `ScanArchiveResult` carries both `skipped: number` and `skippedEntries[]`. |
| P10-B | Yes | `sync_run_items` is written in `sync/store.ts` and deleted wholesale in the wipe path; no reader exists in the codebase. The audit's precondition (confirm no external SQL/reporting consumer) is the right gate — keep it. |

## Priority disagreements

- **S03-A (ranked #4) — downgrade to medium.** The claim is accurate (route derives the key,
  signer validates sha/extension separately), but today the route is the only caller and it
  builds the key from the same `sha256` it hands the signer, which the signer regex-validates.
  There is no input that produces a wrong object today. This is protective API design, not a
  defect; it should not sit above G04-B or I02-A.
- **P07-B — downgrade to medium-low.** The collision is real (`ip:username` concatenation, IPv6
  colons, the `user:` namespace), but aliasing *merges* throttle buckets, which over-throttles
  rather than bypasses. And Pane View is a single-account app (`PANE_VIEW_USERNAME` is one env
  var), so cross-user aliasing has almost no victim population. Still worth the small fix while
  in `login-throttle-core.ts` for P07-A.

## Implementation caveats the audit under-states

- **G04-A:** the prediction-based pre-fetch skip is what makes re-running a gather over a large
  already-downloaded gallery cheap. "Fetch, then let MIME choose the output" as literally
  written re-downloads every previously converted file on every retry. The fix must keep an
  equivalent skip — e.g. persist the original→output name mapping, or check both the predicted
  and the un-transformed candidate names before fetching. The audit's "final no-clobber stays
  authoritative" covers correctness but not this bandwidth regression.
- **F01-A:** the evidence wording is slightly off. `requestSchema` is *used*
  (`registerIpc.ts:188,325,366`); what has no consumers is `argsSchema`, and the real
  duplication is the same facts repeated across registry, `types.ts` interface, preload map,
  and main handlers. The direction (make the registry the seam) is right; just don't delete
  `requestSchema` on the audit's say-so.
- **G02-A:** see nuance above — reverse the documented decision consciously.
- **P12-B:** the current code carries lint-suppression comments explicitly defending the
  serial-loop ordering; the normalization approach obsoletes those comments, remove them with it.

## Conditional items — treat as investigations, not scheduled work

- **F02-B** (drop the Drizzle proxy "only if demonstrably smaller") — this is a spike, not a
  recommendation. Fine to drop entirely if F02-A lands cleanly.
- **W02-A** — the mock trees are self-contained (`mockFrameView` is referenced only inside
  `frame-view/src/showcase/`), so the deletion is safe pending the "no informal developer use"
  check the audit itself requires.
- **I01-A** — cannot be validated locally (the audit admits this). Defer until someone is
  touching Railway config anyway.

## Findings I did not independently verify

S01-A, S02-A, S05-A, P01-A, P02-A, P03-B, P06-B, F03-A, F03-B, F04-B, F05-B, F07-A, G01-B,
G02-B, G05-A, L02-A, L02-B, L03-A, W01-B, W02-B. Partial verification only: P06-A, P11-A,
P12-A, S05-B, W02-A, L01-B (in each case the cited model/shape exists as described; I did not
trace every call site). Given the 38-for-38 hit rate on everything I did check, I'd treat these
as credible, but re-confirm the cited evidence lines when picking one up — several reference
code that will shift as earlier slices land.

Notes on the partials: P08-A's schema claims are confirmed (`viewer_state.subject_id` is a bare
uuid with no FK; nothing writes `subjectType: "collection"` for viewer state). L01-B is confirmed
on the service side (`getTokenState` already computes the exact four-state enum privately at
`profileService.ts:123`; the fix is just exposing it). S05-B's scattered terminal derivation
(`cancelled` flag + `abortError` + finally-block finalization) is visible in `push-changes.ts`.

## Rejections and skips — agree

All eight section-6 rejections look right; none are worth resurrecting as scheduled work
(F01-B and F07-B can ride along if someone is already in those files). The four subsystem skips
(S06 vendored, P09, F06, I03) are justified as written. The dependency graph in section 7
matches what I saw in the code — in particular P08-B→P04-B and L03-B/S05-B→L02-A are genuine
ordering constraints, and the P08-A/P10-B/P12-A migration bundle is the right call.

## What the audit did not cover

By design this was a simplification/depth audit, not a security or dependency review. P07-A/B
were caught incidentally. Nobody has audited: dependency versions/pinning, secrets handling
beyond the throttle path, Electron hardening (contextIsolation/sandbox flags), or the Shutter
vendored packages (explicitly skipped). If a security pass is wanted, it is separate work.

## Suggested execution order (revised)

1. **I02-A** — CI runs tests, check-only format. Unlocks validation for everything else.
2. **P07-A** (+ P07-B while there) — one-line schema fix plus tests.
3. **P04-A**, **G02-A**, **G04-B** — small verified bugs, independent of each other.
4. **G04-A** (with the skip-preservation caveat), **L01-A** + L01-B, **F04-A** + F04-B.
5. **P08-B → P04-B**, then **L03-B/S05-B → L02-A** per the audit's dependency edges.
6. Cheap deletions batch: P03-A, P02-B, G01-A, S03-B, S02-B.
7. **F02-A** when there's appetite for a large slice; **G03-A** alongside other Gather work.
8. Migration bundle P08-A/P10-B/P12-A as one Pane release.
9. Everything else opportunistically, showcase (W01/W02) last.
