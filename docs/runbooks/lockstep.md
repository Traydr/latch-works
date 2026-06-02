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

`push` is scaffolded but intentionally stops before upload until the Pane View ingest API and Railway bucket credentials are wired.

```powershell
$env:LOCKSTEP_API_URL = "http://localhost:3000"
$env:LOCKSTEP_API_TOKEN = "replace-me"
pnpm lockstep -- push --source "T:\cloud-desktop\media"
```

The token environment variable can be changed:

```powershell
pnpm lockstep -- push --source "T:\cloud-desktop\media" --api-token-env "MY_LOCKSTEP_TOKEN"
```
