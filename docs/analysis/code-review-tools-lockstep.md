# Code Review: Lockstep

**Date:** 2026-06-12  
**Scope:** `tools/lockstep/` — archive sync CLI

---

## Executive summary

Lockstep is a well-structured CLI with good token hygiene (env-only secrets, never logged) and clean separation between config, options parsing, commands, and interactive prompts. However, **`--max-changes` has dangerous interaction with sync-plan ordering** (deletes are last and get skipped), and push/verify/network paths have **zero test coverage**. Several correctness and security gaps around path containment and partial-failure semantics need attention.

---

## Architecture

```
cli.ts → options.ts (parse/merge) → commands.ts (plan/verify/push/doctor)
                                  → interactive.ts (prompts)
                                  → config.ts (persist ~/.latch-works/lockstep.json)
```

Lockstep depends on `@latch-works/media-index` for scanning and sync planning, and calls Pane View sync API endpoints for remote operations.

---

## Findings

### Critical / High

#### 1. `--max-changes` can skip deletions entirely

`changedItems` preserves sync-plan order: local uploads/updates first, remote-only deletes last (`packages/media-index/src/sync-plan.ts`). Slicing to `--max-changes N` takes the first N items, so a capped push can upload many files and never process deletes. Remote catalog stays stale while the CLI reports success for the capped batch.

```116:148:tools/lockstep/src/commands.ts
  const changedItems = plan.items.filter((item) => item.action !== "keep");
  // ...
  const itemsToPush = options.maxChanges
    ? changedItems.slice(0, options.maxChanges)
    : changedItems;
```

**Impact:** First-deployment testing with `--max-changes` (recommended in runbooks) can leave remote state inconsistent with deletes never applied.

#### 2. `--max-changes` disables automatic hashing

```70:71:tools/lockstep/src/commands.ts
  const willHash =
    options.hashFiles || (options.command === "push" && !options.maxChanges);
```

A capped push without explicit `--hash` indexes by size/mtime only. Same-size content changes are treated as `keep` and are not pushed. Contradicts runbook guidance to use `--max-changes` for first-deployment testing.

#### 3. Partial push failures leave inconsistent remote state

Per-item errors are caught and the loop continues. No rollback, no abort-on-first-failure, no sync-run finalization. A half-finished push can leave some files uploaded/registered, some deletes applied, and others not — with `exitCode = 1` only at the end. Pane View leaves `sync_runs.status` as `"running"` forever (no completion endpoint).

#### 4. Upload can be skipped but ingest still runs

If `uploadUrl` is null, Lockstep logs "skipped (storage not configured)" but still calls `/api/sync/complete-object`. Can register `library_entries` pointing at an `objectKey` with no blob in storage.

#### 5. No tests for push/doctor/network paths

Existing tests cover `config.ts`, `options.ts` parsing/merge, and `progress.ts` formatting only. Zero tests for `executeCommand`, `pushMediaItem`, `fetchRemoteSnapshot`, `uploadFile`, `localFilePath`, `runDoctor`, or error/exit-code behavior.

---

### Medium

#### 6. `localFilePath` has no containment guard

```553:555:tools/lockstep/src/commands.ts
function localFilePath(sourceRoot: string, archivePath: string): string {
  return path.join(sourceRoot, ...archivePath.split("/"));
}
```

No `path.resolve` + `startsWith(sourceRoot)` check. A path like `../../etc/passwd` (from a crafted snapshot or future bug) could read outside the archive during push.

#### 7. Non-interactive `--source` is not validated

`validateSourceDirectory` runs only in interactive prompts. CLI mode passes `--source` straight into `scanArchive` without early rejection.

#### 8. Silent skip when `item.local` is missing for non-delete actions

Non-delete plan items without `local` hit `continue` without incrementing `failed` or logging.

#### 9. `plan` / `verify` without `--hash` can false-pass on content drift

When neither side has `sha256`, only size is compared. Same-size content changes reported as `keep`; `verify` exits 0 incorrectly.

#### 10. `--yes` is parsed but not enforced in `executeCommand`

`--yes` only affects interactive partial prompts. Non-interactive push never prompts anyway. Documented "confirmation bypass" semantics do not match code.

#### 11. API token missing from `getMissingFields`

Missing token detected late with `exitCode = 2`, while missing `source`/`apiUrl` throw earlier. Inconsistent UX for automation scripts.

#### 12. Bearer token sent in cleartext when `apiUrl` is HTTP

Expected for `localhost`, but no warning in `doctor` or `push` when URL is not HTTPS.

#### 13. API error bodies included in thrown/logged messages

`postJson` embeds `await response.text()` in errors printed by the push loop. Server stack traces may end up in CI logs.

#### 14. Config saved after failed runs

`configStore.save` runs even when `executeCommand` sets `exitCode` to 1 or 2.

---

### Low

- **L1** — Symlinks skipped as `not-a-regular-file` (media behind symlinks invisible).
- **L2** — `--api-token-env` accepts arbitrary strings (typos fail opaquely).
- **L3** — `readRemoteSnapshot` does not normalize/reject `..` in paths.
- **L4** — No sync-run manifest JSONL (`syncRunManifestKey` exists in media-storage but unused).
- **L5** — `completeSyncedObject` records all ingests as action `"upload"` (updates not distinguished).

---

## Security: API token handling

### Good

- Tokens read only from env (`process.env[options.apiTokenEnv]`), never from flags or config.
- Console output shows "configured via …" only, never the secret.
- Bearer header format is correct.
- Config file stores `source` and `apiUrl` only.

### Gaps

- No HTTPS enforcement or warning.
- No path containment on local reads.
- Stale/empty `--remote-snapshot` on push is an operational delete risk.

---

## Positive observations

1. Clean CLI structure with reporter abstraction for progress output.
2. Interactive mode with config persistence (`~/.latch-works/lockstep.json`).
3. `doctor` command for connectivity and auth verification.
4. Scan progress reporting with hashing stage distinction.
5. Options parsing tests cover merge precedence and flag combinations.
6. Token never persisted to disk or printed to console.

---

## Test coverage gaps

| Area | Status | Suggested coverage |
|------|--------|-------------------|
| `config.ts` | Tested | — |
| `options.ts` | Tested | — |
| `progress.ts` | Tested | — |
| `commands.ts` | **Untested** | push happy path, delete path, per-item failure, `maxChanges` ordering |
| `localFilePath` | **Untested** | `..` rejection, Windows/POSIX paths |
| `fetchRemoteSnapshot` | **Untested** | Malformed JSON, invalid entries |
| `runDoctor` | **Untested** | 401/403/5xx, unreachable host (mocked) |
| `uploadFile` | **Untested** | Failed PUT, progress callbacks |
| `cli.ts` | **Untested** | Config not saved on failure; exit codes |
| Integration | **Untested** | Mock sync API end-to-end push of 1 file |

---

## Recommended priority fixes

1. Fix `--max-changes` ordering — process deletes in a separate pass or warn when deletes are truncated.
2. Always hash on push regardless of `--max-changes`.
3. Add path containment check in `localFilePath`.
4. Add push/verify integration tests with mocked API.
5. Add sync-run completion endpoint on Pane View side.
6. Validate `objectKey` consistency in complete-object (coordinate with pane-view fix).
7. Document `--max-changes` delete-skipping behavior in runbook until code is fixed.
