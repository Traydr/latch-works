# Decision 0001: Phase 0 Answers

Date: 2026-06-02

These decisions close the open questions in `ARCHITECTURE_PLAN.md` and guide the first implementation.

## Archive Size

The current archive is 35.9 GB. Plan for roughly 1 GB of growth per month.

## Users

Pane View is strictly single-user for now. The schema can stay simple and does not need team or allowlist UX.

## Media Delivery

Short-lived signed URLs are acceptable. This is the default delivery mode because it is better for large files, videos, and mobile range requests.

## Offline

iPad/iPhone offline access is out of scope for now. Pane View is online-only.

## Paths

Lockstep should preserve local-folder-like paths exactly as they exist today. Logical paths are first-class archive metadata.

## Deletes

When a local file disappears, the remote entry should be removed by sync. Lockstep still plans deletions explicitly so destructive sync behavior is visible.

## Browsing Model

Folder and path browsing is the main mental model. Source-site metadata can be added later for search and richer grouping.

## Previews

Web-compatible previews are acceptable for videos and oversized media. Originals should remain available, with optimized previews generated as a derived asset.

## Storage

Prototype storage can live fully on Railway. The implementation still keeps object storage behind an interface so S3/R2/Bunny-style storage can be swapped in later.
