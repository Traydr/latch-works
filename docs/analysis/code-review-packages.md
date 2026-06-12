# Code Review: Shared Packages

**Date:** 2026-06-12  
**Scope:** `packages/media-domain`, `packages/media-index`, `packages/media-storage`, `packages/media-delivery`

---

## Executive summary

The shared packages are small, focused, and generally well-structured. The highest-impact issue is a **logic bug in `scanArchive`** that fails to skip unsupported file types because `detectMediaType` returns the string `"unknown"`, which is truthy. The domain package already exports `isSupportedMediaFile()` for exactly this check, but nothing in the repo uses it.

Secondary concerns include sync-plan drift when hashes are absent, API surface inconsistencies in storage key helpers, duplicated domain logic in `frame-view`, and significant test coverage gaps outside core happy paths.

---

## `@latch-works/media-domain`

### Overview

| | |
|---|---|
| **Purpose** | Shared media types, path normalization, sorting, comic grouping, browser entry building, OS junk filtering |
| **Dependencies** | `zod` |
| **Public API** | `browser-entries`, `comics`, `media`, `paths`, `sort`, `system-files` |

### Findings

#### High

**H1 — `isSupportedMediaFile` exists but is never used; callers use a broken truthiness check**

```85:87:packages/media-domain/src/media.ts
export function isSupportedMediaFile(fileName: string): boolean {
  return detectMediaType(fileName) !== "unknown";
}
```

This helper is exported but unused anywhere in the repo. Downstream `media-index` `scanArchive` uses `if (!mediaType)` instead, which never triggers for `"unknown"`. The domain package should either document this pitfall prominently or guide consumers toward `isSupportedMediaFile`.

#### Medium

**M1 — `leafFoldersOnly` silently disables filtering when `folders` is omitted**

In `comics.ts`, if `leafFoldersOnly: true` is passed without `folders`, parent folders with images are included as comics with no runtime warning.

**M2 — `buildBrowserEntries` only applies `sortMode` to folders**

Media and comic entries keep caller input order. `GalleryPage` pre-sorts, but the API contract is implicit — callers passing unsorted `items` get inconsistent UX for date/random modes.

**M3 — `formatBytes` has no bounds checking**

For `bytes < 0`, `NaN`, or values ≥ 1024⁵, `sizes[i]` is `undefined` → `"NaN undefined"`.

**M4 — Zod schemas exported but never used for runtime validation within packages**

`MediaItemSchema`, `FolderNodeSchema`, etc. are defined but never `.parse()`'d in-package. `frame-view` duplicates schemas in `src/shared/contracts.ts`, creating drift risk.

**M5 — `FolderNodeSchema.parentId` requires UUID**

If folder IDs are path-derived elsewhere, validation would reject valid data. Currently unused in-package, but a latent API contract issue.

#### Low

- **L1** — `ImageExtensions` includes `"gif"` but `detectMediaType` handles gif separately (harmless redundancy).
- **L2** — `sortMediaItems` default branch masks invalid `sortMode` at runtime (falls back to name-asc).
- **L3** — `createRandomSeed` is not cryptographically secure (fine for gallery shuffle).

### Test coverage

| Module | Tests | Gaps |
|--------|-------|------|
| `media.ts` | `detectMediaType`, partial sort/comics | `isSupportedMediaFile`, `getExtension` edge cases |
| `paths.ts` | **None** | `toArchivePath`, `getParentPath`, `joinArchivePath`, `formatBytes` |
| `sort.ts` | name-asc only | `name-desc`, date modes, `random`, `hashString` |
| `comics.ts` | grouping + leafFoldersOnly | `sortComicEntries`, `leafFoldersOnly` without `folders` |
| `browser-entries.ts` | **None** | recursive mode, comicMode, sortMode interaction |
| `system-files.ts` | Good coverage | — |

**Overall:** ~40% of exported functions have direct tests.

---

## `@latch-works/media-index`

### Overview

| | |
|---|---|
| **Purpose** | Local archive scanning and sync plan generation |
| **Dependencies** | `@latch-works/media-domain` |
| **Public API** | `scanArchive`, `createSyncPlan`, progress/result types |

### Findings

#### High

**H1 — `scanArchive` does not skip unsupported file types (bug)**

```117:129:packages/media-index/src/scan.ts
      const mediaType = detectMediaType(entry.name);
      if (!mediaType) {
        skippedEntries.push({
          path: relativePath,
          reason: "unsupported-extension",
        });
        // ...
        continue;
      }
```

`detectMediaType("notes.txt")` returns `"unknown"` (truthy). Unsupported files are indexed as `MediaItem` with `mediaType: "unknown"` instead of being skipped.

**Impact:**

- Lockstep `plan`/`push` treats `.txt`, `.zip`, etc. as media.
- Pollutes sync counts and can upload non-media to S3.
- `skippedEntries` with reason `"unsupported-extension"` is effectively dead code.

**Fix:** Use `isSupportedMediaFile(entry.name)` or `mediaType === "unknown"`. Add a test with a `.txt` file.

#### Medium

**M1 — `createSyncPlan` can falsely `keep` when local hash is absent**

When `hashFiles: false` (default for `plan`), local `sha256` is undefined. If remote has a hash and sizes match, content changes are missed → false `keep`. Lockstep re-hashes on push, but `plan`/`verify` can report incorrect state.

**M2 — Duplicate paths silently collapse in sync plan Maps**

Last entry wins with no warning. Duplicate paths in input produce silent data loss.

**M3 — No path normalization in sync plan**

`"sfw/a.jpg"` vs `"sfw//a.jpg"` or differing slash/casing conventions produce false upload+delete pairs.

**M4 — `MediaItem.id` changes between hashed and non-hashed scans**

`id` is path-based without hashing, content-addressed with hashing. Downstream systems assuming stable IDs across scan modes may break.

**M5 — `scanArchive` has no input validation or graceful error handling**

No check that `sourceRoot` exists or is a directory. Permission errors on a subtree abort the entire scan.

**M6 — TOCTOU between `stat` and `hashFile`**

If a file changes during hashing, `size`/`mtimeMs` may not match `sha256`.

#### Low

- **L1** — `createSyncPlan` counts computed with four filter passes (minor performance).
- **L2** — `hashFile` calls `onProgress` on every stream chunk without throttling.

### Test coverage

| Module | Tests | Gaps |
|--------|-------|------|
| `scan.ts` | OS junk skip (1 test) | **Unsupported extension skip (would catch H1)**, `hashFiles: true`, symlinks, permission errors |
| `sync-plan.ts` | 1 test (counts only) | Does not assert `items` array; no missing-hash false-keep; no path normalization |

---

## `@latch-works/media-storage`

### Overview

| | |
|---|---|
| **Purpose** | Content-addressed S3 object key layout and S3 client helpers |
| **Dependencies** | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@latch-works/media-domain` |
| **Public API** | Key functions, S3 config/client, signed URLs, head/get/put/delete |

### Findings

#### Medium

**M1 — `isNotFoundError` may miss some S3-compatible provider errors**

Only checks `error.name === "NotFound" || error.name === "NoSuchKey"`. Some providers surface 404 via `$metadata.httpStatusCode` with a different `name`.

**M2 — `readStoredObjectBytes` buffers entire object in memory**

No size limit at the storage primitive level. App layer caps at 512 MB for derivatives, but reuse elsewhere is risky.

**M3 — `assertSha256` throws generic `Error` on invalid input**

Callers without pre-validation return 500 instead of 400. Error message includes the invalid value (minor info leak).

**M4 — `ObjectKeyParts` includes unused fields**

`mediaType` is required on `ObjectKeyParts` but ignored by `originalObjectKey`. Same for `extension`/`mediaType` on `thumbnailObjectKey`. Misleading API.

**M5 — `syncRunManifestKey` performs no ID sanitization**

A `syncRunId` containing `/` or `..` produces keys outside the intended namespace. Currently unused outside tests.

#### Low

- **L1** — Presigned GET default TTL is 60 seconds (may be short for large previews).
- **L2** — `headStoredObject` coerces missing `ContentLength` to `0`.
- **L3** — No integration tests for S3 CRUD operations.

### Test coverage

Key layout well-tested (`index.test.ts`, `s3.test.ts` config parsing). S3 client wrapper largely untested.

---

## `@latch-works/media-delivery`

### Overview

| | |
|---|---|
| **Purpose** | HMAC-signed CDN delivery tokens for thumbnails and previews |
| **Dependencies** | Node `crypto` only |
| **Public API** | `createDeliveryTokenSigner`, `buildCdnDeliveryPath`, `readDeliveryTokenExpiration`, thumbnail size helpers |

### Findings

#### Low

**L1 — Token expiry uses ceiling bucket alignment**

`readDeliveryTokenExpiration` rounds up to the next TTL boundary. Tokens may live slightly longer than `ttlSeconds` from issuance — acceptable but worth documenting for cache invalidation planning.

**L2 — No `objectKey` format validation in token payload**

Any string can be signed into a token. Authorization depends on the signer only issuing keys for objects the user may access. This is by design but means a compromised signer can grant access to any bucket key.

### Positive observations

- HMAC-SHA256 with `timingSafeEqual` for signature verification.
- Base64url encoding, `~` separator avoids ambiguity with URL paths.
- Expiry checked on verify.
- Good unit test coverage (`token.test.ts`, `thumbnail-size.test.ts`).

---

## Cross-package concerns

| Concern | Details |
|---------|---------|
| **Duplicated logic in `frame-view`** | `apps/frame-view/src/renderer/utils/comics.ts` and `utils/sort.ts` reimplement domain functions instead of importing `@latch-works/media-domain`. Drift risk. |
| **Duplicated `formatBytes`** | `tools/lockstep/src/progress.ts` duplicates `media-domain` `formatBytes`. |
| **`isSupportedMediaFile` dead code** | Exported from domain, never consumed; scan uses broken alternative. |
| **`MediaType` includes `"unknown"`** | By design in schema, but scan/upload pipelines should reject before persistence. |
| **Schema vs runtime gap** | Zod schemas in `media-domain` are not enforced at scan/sync/storage boundaries. |

---

## Recommended priority fixes

1. Fix `scanArchive` filter — `!isSupportedMediaFile(entry.name)`; add `.txt` skip test.
2. Add sync-plan tests — false-keep without local hash, duplicate paths, full `items` assertions.
3. Add `paths.test.ts` — especially `formatBytes` edge cases.
4. Tighten `ObjectKeyParts` types — each key function only requires fields it uses.
5. Consolidate `frame-view` domain duplication onto `@latch-works/media-domain`.

---

## Severity summary

| Severity | media-domain | media-index | media-storage | media-delivery |
|----------|-------------|-------------|---------------|----------------|
| Critical | 0 | 0 | 0 | 0 |
| High | 1 | 1 | 0 | 0 |
| Medium | 5 | 6 | 5 | 0 |
| Low | 3 | 2 | 3 | 2 |
