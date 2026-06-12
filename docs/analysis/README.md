# Codebase Analysis

In-depth code review of the Latch Works monorepo, conducted 2026-06-12.

## Reports

| Phase | Document | Scope |
|-------|----------|-------|
| 1 | [code-review-packages.md](./code-review-packages.md) | `@latch-works/media-domain`, `media-index`, `media-storage`, `media-delivery` |
| 2a | [code-review-apps-pane-view.md](./code-review-apps-pane-view.md) | TanStack Start web viewer |
| 2b | [code-review-apps-frame-view-gather-box.md](./code-review-apps-frame-view-gather-box.md) | Electron viewer and browser collector |
| 3 | [code-review-tools-lockstep.md](./code-review-tools-lockstep.md) | Archive sync CLI |
| 4 | [code-review-overall.md](./code-review-overall.md) | Cross-cutting architecture, security, testing, CI |
| 5 | [documentation-audit.md](./documentation-audit.md) | Existing docs accuracy and maintenance actions |

## Priority summary

### Fix immediately

1. **`scanArchive` does not skip unsupported files** — `detectMediaType` returns `"unknown"` (truthy), so `.txt`, `.zip`, etc. are indexed as media. See [packages review](./code-review-packages.md#high-1-scanarchive-does-not-skip-unsupported-file-types).
2. **`getLibrarySnapshot` has no authentication** — unauthenticated callers can enumerate the archive and receive signed CDN thumbnail URLs. See [pane-view review](./code-review-apps-pane-view.md#critical-1-getlibrarysnapshot-server-function-has-no-authentication).
3. **Gather Box fanfiction PDF fonts are missing** — only `OFL.txt` exists; PDF generation will fail at runtime. See [gather-box review](./code-review-apps-frame-view-gather-box.md#high-1-fanfiction-pdf-fonts-are-referenced-but-not-shipped).

### Fix soon

4. Lockstep `--max-changes` can skip deletes and disable hashing — [lockstep review](./code-review-tools-lockstep.md).
5. Sync API accepts arbitrary `objectKey` without validation — [pane-view review](./code-review-apps-pane-view.md).
6. Frame View `listFolderChildren` IPC lacks path authorization — [frame-view review](./code-review-apps-frame-view-gather-box.md).
7. Gather Box download URLs are not centrally allowlisted — [gather-box review](./code-review-apps-frame-view-gather-box.md).

### Documentation

Several planning and runbook docs lag implementation. See [documentation audit](./documentation-audit.md) for per-file status and recommended updates.
