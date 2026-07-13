# Plan 026: Attest sync uploads before archive registration

> **Executor instructions**: Preserve the existing wire flow while strengthening it. Run every gate,
> test against the configured local S3-compatible service, and stop if checksum signing is not
> supported. Update `docs/plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat fd5693d..HEAD -- packages/media-storage/src apps/pane-view/src/routes/api.sync.upload-url.ts apps/pane-view/src/server/sync packages/lockstep-core/src/remote-api.ts apps/pane-view/src/env/server.ts .env.example`

## Status

- **Status**: BLOCKED after two revision rounds; signing-shape correction documented below
- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security, bug
- **Planned at**: commit `fd5693d`, 2026-07-13
- **Original finding**: 2

## Why this matters

Pane View derives an immutable object key from a claimed SHA-256 but does not bind upload size or
checksum and registers client metadata without checking S3. A file can also change between Lockstep's
hash and upload streams. The completed flow must prove that the bytes accepted by storage match the
declared hash, size, and content type before any media/library row is committed.

## Current state

- `api.sync.upload-url.ts:16-67` accepts filename/content type/hash, but not size.
- `media-storage/src/s3.ts:336-355` signs only bucket, key, and content type.
- `sync/store.ts:86-170` trusts completion metadata without `headStoredObject`.
- `remote-api.ts:95-150` hashes, opens the file again for upload, then sends the old item size/mtime.
- Content types are validated by `apps/pane-view/src/server/sync/validation.ts`; match that pattern.
- `CONTEXT.md` defines a Source Object as immutable. Do not weaken deterministic SHA-256 keys.
- Partial implementation is retained on branch `codex/026-attest-sync-uploads` at `2dcf74e`; its
  focused suites, root typecheck, and root lint pass. Continue from that branch rather than repeating
  the completed route, HEAD verification, streaming, and unit-test work.
- Live MinIO diagnosis found that `getSignedUrl` hoists `x-amz-checksum-sha256` and
  `x-amz-meta-sha256` into the query while the partial helper also returns both as headers. MinIO
  rejects the valid PUT because `x-amz-meta-sha256` is then an unsigned request header.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Storage tests | `pnpm --filter @latch-works/media-storage test` | all pass |
| Core tests | `pnpm --filter @latch-works/lockstep-core test` | all pass |
| Pane tests | `pnpm --filter @latch-works/pane-view test` | all pass |
| Typecheck | `pnpm typecheck` | exit 0 |

## Scope

**In scope**: `packages/media-storage/src/s3.ts` and tests; upload URL and completion routes/tests;
sync validation/store/tests; `packages/lockstep-core/src/remote-api.ts` plus a new direct test;
Pane env schema and `.env.example` only if a configurable maximum is introduced.

**Out of scope**: changing authentication; batching/concurrent uploads (Plan 036/037); changing
object-key format; deleting existing objects; rotating credentials.

## Git workflow

- Branch: `codex/026-attest-sync-uploads`
- Commit message: `Verify sync upload integrity`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Bind upload capabilities to declared metadata

Require a safe-integer `size` in the upload-target request and reject negative or over-limit values.
Introduce a documented configurable upload maximum with a conservative default only if no existing
deployment limit exists. Sign exact content length, content type, SHA-256 checksum, and immutable
SHA metadata in `PutObjectCommand`; return the headers Lockstep must send rather than duplicating
header knowledge in the client.

For AWS SDK presigning, pass `signableHeaders: new Set(["content-type"])` and
`unhoistableHeaders: new Set(["x-amz-checksum-sha256", "x-amz-meta-sha256"])` to `getSignedUrl`.
The resulting `X-Amz-SignedHeaders` must contain
`content-length;content-type;host;x-amz-checksum-sha256;x-amz-meta-sha256`. Do not return a header
unless it is represented in that signed-header list.

**Verify**: storage and route tests cover missing, negative, oversized, and valid sizes; signed input
contains exact content length and checksum; a URL-structure assertion proves all returned headers are
signed and checksum/SHA metadata are not hoisted.

### Step 2: Make Lockstep upload the exact attested stream

Send size when requesting the target. Apply all server-returned signed headers. Hash bytes as they
pass through the upload transform and compare the resulting digest and byte count with the expected
values before completion. Capture file size/mtime before hashing and verify them after upload; report
a clear retryable "file changed during sync" error on mismatch.

**Verify**: a new `remote-api.test.ts` uses temp files and a local HTTP server to cover exact bytes,
mutation, checksum mismatch, non-2xx upload, progress, and abort cleanup.

### Step 3: Verify storage before database mutation

Extend `StoredObjectHead` to expose checksum/metadata returned by the provider. Before
`completeSyncedObject` mutates the database, HEAD the derived key and compare content length, content
type, and the signed SHA metadata/checksum. Reject missing or mismatched objects. Keep the HEAD outside
the DB transaction so network I/O does not hold database locks, then revalidate run writability in
the transaction.

**Verify**: completion route/store tests reject missing, wrong-size, wrong-type, and wrong-hash heads;
valid completion still creates the same rows.

### Step 4: Exercise the actual local S3 provider

With disposable local objects, prove the provider enforces the signed checksum and content length.
Use synthetic bytes only and remove them through the provider's normal test cleanup. The prior
diagnostic established the expected MinIO behavior for the corrected signing shape: valid PUT returns
200, altered bytes return `XAmzContentChecksumMismatch`, and altered length/type/metadata/checksum
returns `SignatureDoesNotMatch`.

**Verify**: valid PUT + HEAD succeeds; altered bytes or headers are rejected and no completion row is
written.

## Test plan

Follow `packages/media-storage/src/s3.test.ts` for storage mocks and
`apps/pane-view/src/server/sync/routes.test.ts` for route invocation. Add direct core HTTP tests rather
than mocking `remote-api`. Cover zero-byte policy explicitly, file mutation, provider rejection, HEAD
mismatch, and the happy path.

## Done criteria

- [ ] Upload URL requires and bounds size.
- [ ] PUT is cryptographically/checksum-bound to expected bytes where the provider supports it.
- [ ] Pane View HEAD-verifies the object before DB mutation.
- [ ] File mutation never reaches completion registration.
- [ ] All three focused suites and root typecheck pass.

## STOP conditions

- RustFS/production S3 does not support the selected checksum header consistently.
- Presigning exact content length breaks supported clients/providers.
- The installed AWS presigner does not support `signableHeaders` and `unhoistableHeaders`, or the
  resulting URL omits any returned header from `X-Amz-SignedHeaders`.
- Verification requires downloading whole production-sized objects into Pane View memory.
- The fix requires changing deterministic object keys.

## Maintenance notes

Any new upload client must use the returned signed-header contract. Reviewer attention should focus
on provider interoperability, zero-byte handling, and ensuring HEAD/network work stays outside DB
transactions.
