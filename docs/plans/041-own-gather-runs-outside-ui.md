# Plan 041: Own Gather Runs outside transient UI

> **Executor instructions**: Start with the offscreen filesystem proof. Do not move production
> execution until that gate passes. Preserve collision-safe writes and the authoritative local
> archive. Run every gate and update the plan index.
>
> **Drift check (run first)**: `git diff --stat 92b98cb..HEAD -- apps/gather-box CONTEXT.md docs/adr/0001-gather-box-run-architecture.md`

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none
- **Category**: architecture / reliability
- **Planned at**: commit `92b98cb`, 2026-07-15
- **Architecture decision**: ADR 0001

## Why this matters

Gather Box performs collection, fetches, file writes, PDF generation, progress, retries, and
persistence inside `GatherController`, which is constructed independently by the popup and side
panel. Popup focus loss destroys the executing document. Multiple extension pages can accept the
same broadcast and start duplicate work. A Gather Run needs one owner whose lifetime and state do
not depend on either UI surface.

## Current state

- `src/shared/gather-controller.ts` is an 887-line UI-owned implementation.
- `src/popup/downloader.ts` performs remote fetches and File System Access writes.
- `src/popup/fanfiction-story.ts` fetches chapters, generates a PDF, and writes it.
- `src/popup/index.ts` and `src/sidepanel/index.ts` create independent controllers.
- The only controller test casts through private state and covers last-run persistence, not the run
  interface or browser lifecycle.
- Directory handles are already persisted in extension-origin IndexedDB by
  `src/popup/directory-store.ts`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused tests | `pnpm --filter @latch-works/gather-box test` | all Gather tests pass |
| Type/build gate | `pnpm --filter @latch-works/gather-box check` | exit 0 |
| Extension build | `pnpm --filter @latch-works/gather-box build` | offscreen artifacts and manifest are valid |

## Scope

**In scope**: an offscreen execution proof; a single Gather Run coordinator; versioned persisted run
state; exact target identity; one-run locking; moving collection orchestration, fetches, filesystem
writes, PDF generation, retry, and progress out of UI; UI reconnection; interrupted-run recovery;
focused tests.

**Out of scope**: removing the popup or `primaryUi` setting (Plan 042); lazy PDF chunks and final
bundle budgets (Plan 043); source-catalog consolidation (Plan 044); selected collector bundles (Plan
045); sidecar manifest implementation; multiple concurrent Gather Runs.

## Git workflow

- Branch: `codex/041-own-gather-runs-outside-ui`
- Commit message: `Own Gather runs outside extension UI`

## Steps

### Step 1: Prove offscreen filesystem execution

Add a development-only vertical proof using a bundled offscreen document. From a visible extension
page, ask the user to choose a disposable test directory and grant read/write permission. Persist the
directory handle through the existing IndexedDB mechanism. In the offscreen document, load that same
handle, verify `queryPermission({ mode: "readwrite" })`, create a uniquely named synthetic file,
read it back, and delete it.

Use valid offscreen reasons that match the production work (`BLOBS` and `DOM_PARSER`) and record the
justification near document creation. The service worker must ensure document creation is serialized
and must discover an existing document before creating another.

Do not treat `requestPermission()` from the offscreen document as a valid fallback. Permission in
`prompt` or `denied` state must round-trip to visible UI.

**Verify**: a manual Chrome smoke test records Chrome version and platform; an automated test covers
document-creation serialization and permission outcomes; no archive directory is used by the proof.

### Step 2: Define versioned Gather Run state

Create a deep run module with a small command/state interface and explicit adapters for persistence,
targeted collection, execution messaging, and time. Model at least:

- identity: schema version, run ID, source tab/window/URL, Gather Source, creation time;
- phases: preparing, permission-required, collecting, writing, complete, failed, cancelled,
  interrupted;
- progress: completed/total, current item, saved/skipped/failed counts;
- terminal diagnostics and retry input without persisting secrets or raw directory handles.

Allow at most one non-terminal Gather Run per profile. A second start must return an explicit
already-running outcome referencing the existing run, not queue silently or create duplicate work.
Repeated delivery of the same run ID must be idempotent.

Persist authoritative state outside service-worker globals. Coalesce progress writes and flush phase
transitions by adapting the serialized writer established in Plan 032. On startup, classify a stale
non-terminal run as interrupted; do not claim that an unknown fetch/write continued.

**Verify**: tests cover every state transition, invalid transitions, duplicate start, second intent,
service-worker reconstruction, stale-run interruption, persistence failure, and cancellation races.

### Step 3: Make target collection exact

The coordinator captures `tabId`, `windowId`, and URL at intent acceptance and uses that identity for
the entire run. It must not query whichever tab is active later. Before collection, verify the tab
still exists and remains eligible; fail explicitly if it navigated to a different Gather Source.

For this plan, retain the current collector bundle and `ensureCollectorAndCollect` mechanism, but
invoke it only against the captured tab. Plan 045 will replace the monolithic collector.

**Verify**: tests switch active tabs/windows after intent creation and prove collection still targets
the captured tab or reports navigation; unsupported and closed targets become terminal failures.

### Step 4: Move execution into the offscreen document

Move downloader, destination traversal, retry, and story-PDF execution behind the Gather Output seam
into the offscreen context. Initially preserve the current static PDF import; Plan 043 will make it
lazy. The offscreen document loads the directory handle from IndexedDB rather than receiving it over
Chrome runtime messaging.

Validate every incoming message and its intended target context. The service worker coordinates
state; the offscreen document reports progress and terminal results. Keep X media resolution in the
service worker as a privileged source adapter unless evidence supports moving it.

Preserve existing collision behavior: hash identical existing files, skip them, and suffix distinct
collisions. Cancellation must stop starting new items, abort active fetches where possible, close any
open writable stream safely, and leave completed files valid.

**Verify**: adapter tests use in-memory directory/fetch substitutes; browser smoke tests cover a
small image Gather Output and a generated story PDF; closing every visible Gather UI does not stop
the run.

### Step 5: Turn UI controllers into observers

Remove archive-writing authority from `GatherController`. Popup and side panel temporarily remain in
this plan, but both attach to the same persisted Gather Run, render progress, and submit commands.
They never register a listener that can independently execute a start message.

On UI initialization, read the current run and subscribe to updates. On close/reopen, show the same
run identity and progress. Permission-required state exposes a visible action that calls
`ensureDirectoryPermission(..., true)` and then resumes that same run.

**Verify**: tests mount two UI adapters and prove they observe one run without duplicate effects;
closing and remounting preserves run identity; permission-required is not labeled started or failed.

### Step 6: Add browser-level lifecycle coverage

Add a Chrome extension harness that can load `dist`, seed a disposable directory handle through a
test-only page, invoke a run, close the popup/side panel, reopen the side panel, and observe terminal
state. Keep fixtures synthetic and local where source network behavior is not under test.

**Verify**: lifecycle coverage fails against the old UI-owned architecture and passes with one
offscreen execution owner; no test writes outside its disposable directory.

## Test plan

Cover the run state machine, persistence reconstruction, one-run lock, duplicate intent, exact tab,
tab navigation, unsupported source, missing directory, granted/prompt/denied permission, offscreen
creation races, message validation, progress coalescing, cancellation, write failure, UI reconnect,
and interrupted recovery. Preserve existing downloader and last-run regression tests while moving
them behind the new interface.

## Done criteria

- [ ] Offscreen document reads a saved handle and writes a disposable directory after visible grant.
- [ ] Exactly one module owns the active Gather Run and its transitions.
- [ ] Fetches, filesystem writes, retries, and PDF generation no longer execute in popup/side panel.
- [ ] Closing all visible UI does not cancel or duplicate a run.
- [ ] Run target remains exact across tab/window changes.
- [ ] Permission-required, already-running, interrupted, and terminal outcomes are explicit.
- [ ] Gather tests, browser lifecycle harness, typecheck, and build pass.

## STOP conditions

- Offscreen documents cannot load or write through the extension-origin directory handle after a
  visible grant on a supported Chrome version.
- The required offscreen reason would misrepresent production behavior or violate extension policy.
- Runtime messaging cannot carry progress safely without persisting secrets or unbounded payloads.
- Collision-safe writes or user-visible permission semantics would regress.
- Reliable continuation requires keeping a visible extension page open.

## Maintenance notes

Treat the offscreen executor as replaceable platform plumbing behind the Gather Run interface. Keep
authoritative state persisted, validate every message, and assume the service worker or offscreen
document may still disappear because of browser shutdown, extension reload, or process failure.
