# Prior Review Validation

Date: 2026-06-12

This validates the previous agent review that was indexed from the old `docs/analysis/README.md`.

## Summary Verdict

The previous review was mostly useful and grounded. The two highest-value findings were confirmed:
`scanArchive` does not skip unsupported files, and `getLibrarySnapshot` is missing auth.

The main correction is that the Gather Box font finding is false in this checkout. The referenced
Noto Serif TTF files exist in source and built `dist`.

## Prior Priority Findings

| Prior finding | Verdict | Notes |
| --- | --- | --- |
| `scanArchive` does not skip unsupported file types | Confirmed | The truthiness check is wrong. Also fix the same bug in Pane View upload-url. |
| `getLibrarySnapshot` has no authentication | Confirmed | Critical because server functions are callable outside route navigation. |
| Gather Box fanfiction PDF fonts are missing | Rejected | Fonts are present in `apps/gather-box/assets/fonts` and `apps/gather-box/dist/assets/fonts`. |
| Lockstep `--max-changes` can skip deletes and disable hashing | Confirmed with nuance | Hash disabling is the higher-risk issue. Delete skipping means delayed deletes during capped batches. |
| Sync API accepts arbitrary `objectKey` | Confirmed | Also reject `"unknown"` media and validate path/filename/extension consistency. |
| Frame View `listFolderChildren` lacks path authorization | Confirmed with lower severity | Medium in current threat model; high if untrusted renderer content is introduced. |
| Gather Box download URLs are not centrally allowlisted | Confirmed with narrower scope | Chrome host permissions reduce impact, but final fetch/write validation should be centralized. |

## Missing Or Underemphasized Issues

- Pane View `/api/sync/upload-url` has the same `"unknown"` media bug as `scanArchive`.
- Pane View `complete-object` accepts `mediaType: "unknown"`.
- Derivative jobs can stay stuck as `processing` after a crash.
- Lockstep and Pane View do not finalize sync runs.
- Root `pnpm lint` excludes Frame View and Gather Box; Gather Box has no lint script.
- Docs still describe Pane View as read-only despite browser soft-delete.
- Pane View README advertises favorites and resume state ahead of implementation.

## Findings To Narrow

- Lockstep `localFilePath` traversal is currently defense-in-depth because upload paths come from
  the local scanner, not remote snapshots. It is still worth guarding.
- Gather Box is not an unrestricted arbitrary-web fetch surface because manifest host permissions
  constrain cross-origin requests. The right fix is still central URL validation.
- Frame View directory enumeration should be judged against the Electron threat model; current
  sandboxing lowers the immediate risk.

## Final Takeaway

Use the previous review as input, but do not fix the font issue. The first engineering batch should
target unsupported media filtering, snapshot auth, sync ingest validation, Lockstep push hashing,
and regression tests.
