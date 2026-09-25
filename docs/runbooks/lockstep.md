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

The CLI config file stores the last source directory and API URL you passed as a flag or picked in
a prompt, and the wizard's last command. Environment values are not copied into it, and the file
is not rewritten when nothing changed. Run flags (`--hash`, `--show-skipped`, `--max-changes`,
`--upload-concurrency`) apply to one run only; set lasting defaults by hand in the file's
`defaults` block, and turn a boolean default off for one run with `--no-hash` or
`--no-show-skipped`. CLI API tokens are never written to disk; keep using `LOCKSTEP_API_TOKEN`
(or `--api-token-env`).

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

`plan` fetches the live remote snapshot from Pane View when an API URL (`--api-url`,
`LOCKSTEP_API_URL`, or the saved config) and a token are available, like the desktop app's Plan.
`--remote-snapshot` compares against a saved snapshot file instead. With neither, `plan` warns
and compares against an empty remote, so every local file shows as an upload and no deletes
appear.

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

The snapshot file is either a JSON array of entries:

```json
[
  {
    "path": "sfw/patreon/example/file.jpg",
    "size": 1234,
    "sha256": "optional"
  }
]
```

or a saved `GET /api/sync/snapshot` response, `{ "entries": [...], "status": "database" }`:

```powershell
curl.exe -H "Authorization: Bearer $env:LOCKSTEP_API_TOKEN" "$env:LOCKSTEP_API_URL/api/sync/snapshot" -o remote-snapshot.json
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

When delete items are present, Lockstep prints the paths (respecting `--max-changes` if set) and requires `--yes` or interactive confirmation before applying deletes. It then deletes exactly the printed entries from that same plan; it does not plan again, so a remote entry that appeared in the meantime is not touched. Use `prune --yes` only in scripted automation after reviewing a read-only `plan`, and note that `--yes` prunes whatever that run's own plan lists.

Before each delete, prune checks the local path again. If the file is back in the source folder, the delete is skipped and reported as `Skipped delete <path>`; the final line counts deleted, skipped, and failed entries. If the source folder itself is missing (an unmounted drive, for example), prune stops before creating a sync run and deletes nothing.

The desktop app follows the same rule. The main process keeps the last plan for each profile and gives it an id; the **Prune** stage is enabled only when that plan lists at least one delete, its confirmation states how many remote entries will be deleted, and it sends only the plan id back, never paths. A plan can be pruned once: the main process discards it when a prune starts, and a prune is refused if the profile's API URL or source folder changed since the plan.

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
