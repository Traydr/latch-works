# Lockstep Runbook

Lockstep is the local archive to Pane View sync CLI.

## Interactive Mode

When run from a terminal with no arguments, Lockstep starts a guided wizard:

```powershell
pnpm start:lockstep
```

If you omit required flags on a command (for example `pnpm start:lockstep -- push`), Lockstep prompts for the missing values instead of failing immediately. Non-TTY environments (CI, pipes) keep the strict flag-based behavior.

Lockstep remembers non-secret settings between runs in:

```text
%USERPROFILE%\.latch-works\lockstep.json
```

The file stores values such as your last source directory and API URL. API tokens are never written to disk; keep using `LOCKSTEP_API_TOKEN` (or `--api-token-env`).

Optional environment overrides:

- `LOCKSTEP_SOURCE` — default local archive path (overrides the config file)
- `LOCKSTEP_API_URL` — default Pane View API URL
- `LOCKSTEP_API_TOKEN` — sync API bearer token

For scripted push without interactive confirmation, pass `--yes`:

```powershell
pnpm start:lockstep -- push --source "T:\cloud-desktop\media" --yes
```

## Doctor

Check Node, env configuration, and API connectivity:

```powershell
pnpm start:lockstep -- doctor
pnpm start:lockstep -- doctor --source "T:\cloud-desktop\media"
```

When `LOCKSTEP_API_URL` and `LOCKSTEP_API_TOKEN` are set, doctor requests `/api/sync/snapshot` and reports reachability.

Lockstep prints live progress to stderr while it works: indexing paths, hash byte counts, and per-file push stages (`Hashing`, `Uploading`, `Registering`). In a TTY terminal the current step updates in place; in CI logs each update is written on its own line.

## Read-Only Plan

```powershell
pnpm start:lockstep -- plan --source "T:\cloud-desktop\media"
```

Add `--hash` when the plan needs content hashes. Hashing a 35.9 GB archive will take longer but gives better change detection.

```powershell
pnpm start:lockstep -- plan --source "T:\cloud-desktop\media" --hash
```

Show every skipped non-media file:

```powershell
pnpm start:lockstep -- plan --source "T:\cloud-desktop\media" --show-skipped
```

## Verify Against a Snapshot

`verify` requires `--remote-snapshot`. It exits with code `1` when any path differs from the snapshot (upload, update, or delete actions).

```powershell
pnpm start:lockstep -- verify --source "T:\cloud-desktop\media" --remote-snapshot remote-snapshot.json --hash
```

The snapshot format is a JSON array:

```json
[
  {
    "path": "sfw/patreon/example/file.jpg",
    "size": 1234,
    "sha256": "optional"
  }
]
```

## Push

`push` sends the current local plan to the Pane View sync API. It hashes files automatically, fetches the remote snapshot when `--remote-snapshot` is not provided, asks the API for upload targets, uploads originals when storage credentials are configured, and records deletes for local paths that disappeared.

```powershell
$env:LOCKSTEP_API_URL = "http://localhost:3000"
$env:LOCKSTEP_API_TOKEN = "replace-me"
pnpm start:lockstep -- push --source "T:\cloud-desktop\media"
```

For the deployed Pane View domain:

```powershell
$env:LOCKSTEP_API_URL = "https://pane-view.traydr.dev"
$env:LOCKSTEP_API_TOKEN = "replace-me"
pnpm start:lockstep -- push --source "T:\cloud-desktop\media" --max-changes 25
```

You can also pass `--api-url` instead of setting `LOCKSTEP_API_URL`, but the sync token must still be available through `LOCKSTEP_API_TOKEN` or the environment variable named by `--api-token-env`.

The token environment variable can be changed:

```powershell
pnpm start:lockstep -- push --source "T:\cloud-desktop\media" --api-token-env "MY_LOCKSTEP_TOKEN"
```

For first deployment verification, run `push` against a small test folder before pointing it at the full `T:\cloud-desktop\media` archive.

To test the full archive plan while uploading only the first small batch of changed files, cap the push:

```powershell
pnpm start:lockstep -- push --source "T:\cloud-desktop\media" --max-changes 25
```

`push` always hashes local files before planning, even when `--max-changes` is set. Capped pushes take the first N planned changes in plan order. If that cap skips delete actions, Lockstep prints a warning with the number of delayed deletes. Each push run is finalized through `/api/sync/runs/{id}/complete` with `completed` or `failed` status and final counts.
