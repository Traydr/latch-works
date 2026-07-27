# Lockstep Runbook

Lockstep is the local archive to Pane View sync CLI.

## Interactive Mode

When run from a terminal with no arguments, Lockstep starts a guided wizard:

```powershell
pnpm start:lockstep
```

If you omit required flags on a command (for example `pnpm --filter @latch-works/lockstep start push`), Lockstep prompts for the missing values instead of failing immediately. Non-TTY environments (CI, pipes) keep the strict flag-based behavior.

Lockstep remembers non-secret settings between runs in:

```text
%USERPROFILE%\.latch-works\lockstep.json
```

The CLI config file stores values such as your last source directory and API URL. CLI API tokens
are never written to disk; keep using `LOCKSTEP_API_TOKEN` (or `--api-token-env`).

Optional environment overrides:

- `LOCKSTEP_SOURCE` — default local archive path (overrides the config file)
- `LOCKSTEP_API_URL` — default Pane View API URL
- `LOCKSTEP_API_TOKEN` — sync API bearer token

## Desktop GUI Token Storage

The Lockstep desktop app stores per-profile sync tokens with Electron `safeStorage`. On macOS,
Electron stores the encryption key in Keychain, and Keychain ties access to the app identity and code
signature. An installable app produced without a fresh signature can write the token during one
process, then fail to unlock it after restart.

The macOS Forge package now uses a stable bundle id:

```text
dev.traydr.latchworks.lockstep
```

`pnpm make` signs macOS packages by default. If `LOCKSTEP_MACOS_SIGN_IDENTITY` is unset, Forge uses
an ad-hoc signature for local same-machine testing and gives the Electron app/helper bundles the
local-only `com.apple.security.cs.disable-library-validation` entitlement. For builds that will be
shared or installed on another Mac, set `LOCKSTEP_MACOS_SIGN_IDENTITY` to an Apple Developer ID
Application certificate and notarize before distribution.

Useful checks on the build machine:

```bash
security find-identity -v -p codesigning
codesign --verify --deep --strict --verbose=2 apps/lockstep/out/Lockstep-darwin-arm64/Lockstep.app
codesign -dv apps/lockstep/out/Lockstep-darwin-arm64/Lockstep.app
```

`codesign -dv` should show `Identifier=dev.traydr.latchworks.lockstep`, not `com.github.Electron`.
If launch fails with `Library not loaded: @rpath/Electron Framework.framework/Electron Framework`
and `mapped file (non-platform) have different Team IDs`, the app/helper bundles were signed without
the local ad-hoc helper entitlement or were signed with mixed identities.
If a user previously saved a token with the invalid unsigned package, they should re-enter the token
once after installing the fixed build. The old encrypted blob may remain unreadable because Keychain
was asked to protect it for a different or invalid code requirement.

For scripted `push` or `prune` without interactive confirmation, pass `--yes`:

```powershell
pnpm --filter @latch-works/lockstep start push --source "T:\cloud-desktop\media" --yes
pnpm --filter @latch-works/lockstep start prune --source "T:\cloud-desktop\media" --yes
```

## Doctor

Check Node, env configuration, and API connectivity:

```powershell
pnpm --filter @latch-works/lockstep start doctor
pnpm --filter @latch-works/lockstep start doctor --source "T:\cloud-desktop\media"
```

When `LOCKSTEP_API_URL` and `LOCKSTEP_API_TOKEN` are set, doctor requests `/api/sync/snapshot` and reports reachability.

Lockstep prints live progress to stderr while it works: indexing paths, hash byte counts, and per-file push stages (`Hashing`, `Uploading`, `Registering`). In a TTY terminal the current step updates in place; in CI logs each update is written on its own line.

## Read-Only Plan

```powershell
pnpm --filter @latch-works/lockstep start plan --source "T:\cloud-desktop\media"
```

Add `--hash` when the plan needs content hashes. Hashing a 35.9 GB archive will take longer but gives better change detection.

```powershell
pnpm --filter @latch-works/lockstep start plan --source "T:\cloud-desktop\media" --hash
```

Show every skipped non-media file:

```powershell
pnpm --filter @latch-works/lockstep start plan --source "T:\cloud-desktop\media" --show-skipped
```

## Verify Against a Snapshot

`verify` requires `--remote-snapshot`. It exits with code `1` when any path differs from the snapshot (upload, update, or delete actions).

```powershell
pnpm --filter @latch-works/lockstep start verify --source "T:\cloud-desktop\media" --remote-snapshot remote-snapshot.json --hash
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

`push` sends upload and update changes to the Pane View sync API. It fetches the remote snapshot,
uses cached hashes for unchanged local files, hashes equal-size cache misses to detect content changes,
and defers hashes for obvious uploads or size changes until those items are selected for upload. It
then asks the API for upload targets and uploads originals when storage credentials are configured.
`push` never applies remote deletes — use `prune` for those.

```powershell
$env:LOCKSTEP_API_URL = "http://localhost:3000"
$env:LOCKSTEP_API_TOKEN = "replace-me"
pnpm --filter @latch-works/lockstep start push --source "T:\cloud-desktop\media"
```

For the deployed Pane View domain:

```powershell
$env:LOCKSTEP_API_URL = "https://replace-with-pane-view-domain"
$env:LOCKSTEP_API_TOKEN = "replace-me"
pnpm --filter @latch-works/lockstep start push --source "T:\cloud-desktop\media" --max-changes 25
```

You can also pass `--api-url` instead of setting `LOCKSTEP_API_URL`, but the sync token must still be available through `LOCKSTEP_API_TOKEN` or the environment variable named by `--api-token-env`.

The token environment variable can be changed:

```powershell
pnpm --filter @latch-works/lockstep start push --source "T:\cloud-desktop\media" --api-token-env "MY_LOCKSTEP_TOKEN"
```

For first deployment verification, run `push` against a small test folder before pointing it at the full `T:\cloud-desktop\media` archive.

To test the full archive plan while uploading only the first small batch of changed files, cap the push:

```powershell
pnpm --filter @latch-works/lockstep start push --source "T:\cloud-desktop\media" --max-changes 25
```

Capped pushes take the first N upload/update changes in plan order (delete items are excluded) and
only hash the selected obvious uploads or size changes. Equal-size remote entries are still hashed on
a cache miss because size alone cannot prove that their contents match. Each push run is finalized
through `/api/sync/runs/{id}/complete` with `completed` or `failed` status and final counts.

Lockstep stores versioned, per-source hash caches under
`~/.latch-works/hash-cache/v1/`. Cache entries are invalidated when file size, modified time, or the
available change time differs. A missing, malformed, or unwritable cache slows the run down but does
not prevent synchronization.

## Prune

`prune` applies planned remote deletes for paths that exist in the remote snapshot but not locally. It is separate from `push` so destructive sync actions require an explicit operator decision.

When delete items are present, Lockstep prints the paths (respecting `--max-changes` if set) and requires `--yes` or interactive confirmation before applying deletes. Use `prune --yes` only in scripted automation after reviewing a read-only `plan`.

```powershell
$env:LOCKSTEP_API_URL = "http://localhost:3000"
$env:LOCKSTEP_API_TOKEN = "replace-me"
pnpm --filter @latch-works/lockstep start prune --source "T:\cloud-desktop\media"
```

Non-interactive prune (CI/scripts):

```powershell
pnpm --filter @latch-works/lockstep start prune --source "T:\cloud-desktop\media" --yes
```

`prune` does not hash local files unless you pass `--hash`. Remote object bytes are not removed — only `library_entries` are soft-deleted.
