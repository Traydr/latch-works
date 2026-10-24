# Glazier Runbook

Glazier is the desktop workbench for auditing and tidying a local archive: it reports what a root
holds, finds exact and similar duplicates, tells silent videos from ones with sound, and converts
files to the archive formats (AVIF for stills, MP4 for everything that moves). The plan that
introduced it is [058](../plans/058-glazier.md).

## Run it

```sh
pnpm install
pnpm -r --filter './packages/*' build   # Glazier bundles workspace packages from their dist
pnpm --filter @latch-works/glazier-app start
```

`pnpm --filter @latch-works/glazier-app package` builds the production app into
`apps/glazier/out`; `make` produces the DMG and ZIP. The macOS signing identity comes from
`GLAZIER_MACOS_SIGN_IDENTITY`, as for the other apps (see
[electron-macos-signing.md](../electron-macos-signing.md)).

## Where its data lives

| What | Where | Notes |
| --- | --- | --- |
| Catalog (SQLite) | `~/Library/Application Support/Glazier/catalog.sqlite` | Rebuildable from the archive by rescanning. Never authoritative. |
| Thumbnails | `~/Library/Application Support/Glazier/thumbnails/` | Safe to delete. |
| Holding | `<root>/.glazier-holding/<batch>/<original path>` | Removed files and replaced originals. Skipped by every scanner. |

Scanning never writes inside a root. The catalog and thumbnails are the only things a scan
creates.

## Actions that change the archive

Every change is a plan: Glazier previews it (steps, bytes, what Lockstep will see), and only
**Apply** touches files. Before each step it re-reads the file and skips it if its size, mtime or
ctime moved since the scan. Every applied step is in the **Journal**, where **Undo** reverses a
plan's finished steps newest first.

| Action | What happens on disk | Undo |
| --- | --- | --- |
| Move to holding (and resolving duplicates, cleaning junk) | The file is renamed into `<root>/.glazier-holding/<batch>/<its path>`. | Renamed back, unless something now sits at the original path. |
| Move to… / Rename / Fix extension | Renamed in place, or moved to the chosen folder (copied then deleted across volumes, keeping mtime). | Moved back. |
| Convert to AVIF | The AVIF is written to `<target>.glazier-tmp`, checked (decodes, same dimensions, at least 5% smaller), given the original's mtime and renamed into place; the original goes to holding. | The AVIF goes to holding and the original comes back. |
| Animation, video → MP4; re-encode; strip audio | As above, through the Mediabunny transcoder window. The result is checked with ffprobe (video track, duration, dimensions, audio kept or dropped as planned). Re-encodes must save 5%; container moves only need to succeed. | As above. |
| Remove empty folders | Junk files inside go to holding first, then the folder is removed. | The folder is recreated. |
| Restore (Holding view) | The held file is renamed back to its original path. | — |
| Empty to Trash (Holding view) | Each holding batch folder goes to the system Trash (`shell.trashItem`; the Recycle Bin on Windows). | Only from the Trash. |

The original's creation date and extended attributes (Finder tags) are not carried over to a
converted file; its modification date is, so date sorting in Frame View and Pane View holds.

### After a crash or a forced quit

A plan left half-applied is marked **cancelled** on the next launch, and any `*.glazier-tmp`
file beside its pending targets is deleted. Its finished steps stay finished and can be undone.

## Lockstep and Pane View afterwards

Glazier never talks to Pane View. To bring the web library in line after a plan:

```sh
lockstep plan   # converted files show as new paths, their originals as missing
lockstep push
lockstep prune  # soft-deletes the missing paths in Pane View
```

Pane View keeps the old originals in its bucket and in Shutter until a deleted-item purge, as
always. The holding folder is never synced: `.glazier-holding` is in `media-domain`'s system
folder list, which Lockstep's scan and Frame View both skip.

## Formats and encoders

- **Stills** use Gather Box's encoder: libavif's wasm build (`@jsquash/avif`) at quality 70,
  speed 6, retried at speed 8 when the wasm heap runs out. Images over 64 megapixels, which the
  wasm cannot hold, go to sharp's native AVIF at the nearest settings. The settings live in
  `@latch-works/media-format`, which both apps import.
- **Everything that moves** becomes MP4. Video and audio tracks in an archive codec (H.264, HEVC,
  AV1; AAC, MP3) are copied, so moving an H.264 MOV or MKV into MP4 is lossless; other codecs
  become H.264 and AAC. AVI, FLV and WMV are reported, not converted.
- **Re-encoding** to HEVC or AV1 is only done when asked, from the Library. It uses Chromium's
  WebCodecs through Mediabunny, so it gets the machine's hardware encoders; Settings lists which
  are available. Older devices cannot play AV1.

## Similar media

**Find similar** fingerprints every image (a 64-bit DCT perceptual hash) and every video and
animation (hashes of the frames at 10/30/50/70/90% of its duration). It decodes everything once,
so it runs only when asked; results are cached against each file's fingerprint. Matches need the
same aspect ratio (within 3%) and, for video, the same duration (within 1.5 s or 3%). The
strictness levels are Strict, Balanced and Loose.

## Troubleshooting

- **A root shows "is not available"**: its drive is not mounted. The catalog is kept; rescan once
  it is back.
- **Video conversions fail with no encoder**: Settings → Encoders shows what WebCodecs offers.
  Glazier keeps hardware acceleration on for this; nothing else is needed.
- **A step was skipped as "changed since the scan"**: rescan the root and apply again.
