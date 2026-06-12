# Documentation Audit

Date: 2026-06-12

This audit focuses on documentation that remains in the repository after consolidating
`docs/analysis` into the final review notes.

## Highest Priority Updates

### `docs/runbooks/lockstep.md`

Status: partially outdated.

The runbook still uses `pnpm lockstep -- ...` in the plan, verify, and push examples. The root
script is `pnpm start:lockstep -- ...`, and the repo instructions explicitly warn not to use the
old invocation shape.

Also update the `--max-changes` section after the code is fixed. Current behavior delays deletes
when the capped slice does not include them, and capped push currently disables automatic pre-plan
hashing unless `--hash` is passed.

### `docs/end-to-end-request-flow.md`

Status: partially outdated.

The Lockstep example uses the old `pnpm lockstep -- push` command. The browse flow also implies that
route-loader auth protects the library snapshot itself; the final review confirms that
`getLibrarySnapshot` needs its own auth check. Update the media delivery section to reflect the
current `resolveMediaDeliveryUrl`/CDN flow.

### `apps/pane-view/README.md`

Status: partially outdated.

The README describes Pane View as an authenticated read-only gallery, but the app currently exposes
a browser soft-delete action through `deleteLibraryEntry`. It also lists favorites and per-user
viewer resume state as features; favorites have no application code, and viewer-state server
functions are not wired into the modal UI.

### Root `README.md`

Status: partially outdated.

The workspace tree omits `apps/showcase`, even though the workspace and root scripts include it.
The docs tree still references `docs/decisions/`, which does not exist in this checkout. It also
uses broad "read-only remote" language that should be softened or clarified because Pane View has
remote soft delete.

## Lower Priority Updates

### `docs/ARCHITECTURE_PLAN.md`

Status: historical plan.

This should be marked as historical or split into "implemented" and "planned". It still references
unbuilt packages, old Lockstep commands, and an old decision-doc path. Keep it as context, but do
not present it as the current architecture.

### `docs/plans/pane-view-approved-backlog.md`

Status: partially outdated.

Several items appear partially or fully implemented. Re-audit the backlog against the current Pane
View code and update priorities before using it for implementation planning.

### `docs/plans/pane-view-phase-7.md`

Status: partially outdated.

The current state section predates several implemented pieces such as `GalleryPage`,
`SettingsDrawer`, `ComicReader`, `PdfViewer`, and recursive browsing plumbing.

### `apps/frame-view/docs/*`

Status: mixed.

`apps/frame-view/docs/ai-notes.md` appears to be the best current source of truth. Older plan docs
should be marked completed or historical. The feature spec and screen breakdown are still useful but
should be refreshed when Frame View UI changes.

### `tools/lockstep/README.md`

Status: mostly current.

The command examples use `pnpm start:lockstep`. Add a warning about capped push behavior until the
hashing and delete ordering fixes land.

## Analysis Folder Cleanup

Superseded draft review files were removed from `docs/analysis`. The retained files are the final
review set plus `0001-phase-0-answers.md`, which is kept as historical decision context.
