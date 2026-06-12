# Final Codebase Review

Finalized review notes for the Latch Works monorepo, consolidated on 2026-06-12.

## Files

| Document | Purpose |
| --- | --- |
| [final-code-review.md](./final-code-review.md) | Consolidated code review findings across packages, apps, tools, and testing |
| [prior-review-validation.md](./prior-review-validation.md) | Verdict on the previous agent review and what changed after independent validation |
| [documentation-audit.md](./documentation-audit.md) | Current documentation cleanup and drift notes |

## Immediate Fixes

1. Fix unsupported-media filtering in both `scanArchive` and Pane View `/api/sync/upload-url`.
2. Add an auth check to `getLibrarySnapshot`.
3. Harden Pane View sync ingest validation: reject `"unknown"`, validate SHA-256, logical paths,
   filenames, extensions, media type, and derive `objectKey` server-side.
4. Make Lockstep hash on every `push`, including capped pushes.
5. Add tests for the four paths above before expanding into lower-risk cleanup.

## Important Correction

The previous review reported missing Gather Box PDF fonts. That is not true in this checkout:
`apps/gather-box/assets/fonts` and `apps/gather-box/dist/assets/fonts` both contain the four Noto
Serif TTF files referenced by the PDF generator.

## Verification

Focused checks passed during review:

- `pnpm --filter @latch-works/media-index test`
- `pnpm --filter @latch-works/media-domain test`
- `pnpm --filter @latch-works/media-delivery test`
- `pnpm --filter @latch-works/media-storage test`
- `env -u LOCKSTEP_API_URL -u LOCKSTEP_API_TOKEN pnpm --filter @latch-works/lockstep test`
- `pnpm --filter @latch-works/gather-box typecheck`
- `pnpm --filter @latch-works/pane-view test`

Full `pnpm check` was not run because the repository instructions document a known Frame View
Linux test caveat and possible pre-existing lint noise.
