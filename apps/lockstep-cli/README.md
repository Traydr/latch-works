# Lockstep

> Scan a local media archive, plan sync changes, and push originals to Pane View.

Lockstep is the **local → remote bridge** in Latch Works. It walks a source directory, detects media files using shared [`@latch-works/media-index`](../../packages/media-index) logic, compares against a remote snapshot, and uploads changed originals through the Pane View sync API.

`plan` and `verify` are **read-only**. `push` uploads and updates remote files; it never applies deletes. `prune` applies planned remote deletes explicitly and requires confirmation (`--yes` for scripts, or type `prune` at an interactive prompt). `push` always hashes during scan; use `--hash` with `plan` or `verify` for content-accurate comparisons. Capped pushes warn when delete actions are delayed by `--max-changes`, and each run is finalized through `/api/sync/runs/{id}/complete`.

## Commands

| Command | Description |
| --- | --- |
| `plan` | Scan the source tree and print a sync plan (no uploads) |
| `push` | Hash, upload, and register changed files with Pane View |
| `prune` | Apply planned remote deletes (requires `--yes` or interactive confirmation) |
| `verify` | Compare local archive against a remote snapshot file; exits `1` on drift |
| `doctor` | Check Node, config, env vars, and API reachability |

Run with no arguments from a TTY terminal for an **interactive wizard** that prompts for missing values.

## Quick start

From the **repo root**:

```powershell
pnpm start:lockstep
```

Read-only plan:

```powershell
pnpm --filter @latch-works/lockstep start plan --source "T:\cloud-desktop\media"
```

Push to a local Pane View dev server:

```powershell
$env:LOCKSTEP_API_URL = "http://localhost:3000"
$env:LOCKSTEP_API_TOKEN = "your-sync-token"
pnpm --filter @latch-works/lockstep start push --source "T:\cloud-desktop\media"
```

Non-interactive push (CI/scripts):

```powershell
pnpm --filter @latch-works/lockstep start push --source "T:\cloud-desktop\media" --yes
```

Non-interactive prune (CI/scripts; applies remote deletes):

```powershell
pnpm --filter @latch-works/lockstep start prune --source "T:\cloud-desktop\media" --api-url http://localhost:3000 --yes
```

## Configuration

Lockstep remembers non-secret settings between runs:

```text
%USERPROFILE%\.latch-works\lockstep.json
```

Stored values include the last source directory and API URL. **API tokens are never written to disk** — use environment variables.

| Variable | Purpose |
| --- | --- |
| `LOCKSTEP_SOURCE` | Default local archive path |
| `LOCKSTEP_API_URL` | Pane View base URL |
| `LOCKSTEP_API_TOKEN` | Sync API bearer token (matches `PANE_VIEW_SYNC_TOKEN`) |

CLI flags override config and env. Use `--api-token-env` to read the token from a different variable name.

## Useful flags

```powershell
# Content hashing for accurate change detection (slower on large archives)
pnpm --filter @latch-works/lockstep start plan --source "T:\cloud-desktop\media" --hash

# List every skipped non-media file
pnpm --filter @latch-works/lockstep start plan --source "T:\cloud-desktop\media" --show-skipped

# Cap uploads during first deployment testing (still hashes the full archive)
pnpm --filter @latch-works/lockstep start push --source "T:\cloud-desktop\media" --max-changes 25

# Cap remote deletes during prune testing (--yes required without a TTY)
pnpm --filter @latch-works/lockstep start prune --source "T:\cloud-desktop\media" --max-changes 25 --yes

# Verify against a saved snapshot JSON
pnpm --filter @latch-works/lockstep start verify --source "T:\cloud-desktop\media" --remote-snapshot remote-snapshot.json --hash
```

## Progress output

Lockstep reports live progress to **stderr**: indexing paths, hash byte counts, and per-file push stages (`Hashing`, `Uploading`, `Registering`). In a TTY the current step updates in place; in CI each update is a new line.

## Development

```powershell
# From repo root
pnpm --filter @latch-works/lockstep start
pnpm --filter @latch-works/lockstep test
pnpm --filter @latch-works/lockstep typecheck
```

Entry point: `src/cli.ts` (run via `tsx` in dev, compiled to `dist/cli.js` for the `lockstep` bin).

## Dependencies

- [`@latch-works/media-domain`](../../packages/media-domain) — media type detection and path normalization
- [`@latch-works/media-index`](../../packages/media-index) — `scanArchive`, `createSyncPlan`

## Related docs

- [Lockstep runbook](../../docs/runbooks/lockstep.md) — full operational reference
- [Pane View README](../../apps/pane-view/README.md) — sync API target
- [Root README](../../README.md) — monorepo overview
