# Lockstep Runbook

Lockstep is the local archive to Pane View sync CLI.

## Read-Only Plan

```powershell
pnpm lockstep -- plan --source "T:\cloud-desktop\media"
```

Add `--hash` when the plan needs content hashes. Hashing a 35.9 GB archive will take longer but gives better change detection.

```powershell
pnpm lockstep -- plan --source "T:\cloud-desktop\media" --hash
```

Show every skipped non-media file:

```powershell
pnpm lockstep -- plan --source "T:\cloud-desktop\media" --show-skipped
```

## Verify Against a Snapshot

```powershell
pnpm lockstep -- verify --source "T:\cloud-desktop\media" --remote-snapshot remote-snapshot.json --hash
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
pnpm lockstep -- push --source "T:\cloud-desktop\media"
```

For the deployed Pane View domain:

```powershell
$env:LOCKSTEP_API_URL = "https://pane-view.traydr.dev"
$env:LOCKSTEP_API_TOKEN = "replace-me"
pnpm lockstep -- push --source "T:\cloud-desktop\media" --max-changes 25
```

You can also pass `--api-url` instead of setting `LOCKSTEP_API_URL`, but the sync token must still be available through `LOCKSTEP_API_TOKEN` or the environment variable named by `--api-token-env`.

The token environment variable can be changed:

```powershell
pnpm lockstep -- push --source "T:\cloud-desktop\media" --api-token-env "MY_LOCKSTEP_TOKEN"
```

For first deployment verification, run `push` against a small test folder before pointing it at the full `T:\cloud-desktop\media` archive.

To test the full archive plan while uploading only the first small batch of changed files, cap the push:

```powershell
pnpm lockstep -- push --source "T:\cloud-desktop\media" --max-changes 25
```
