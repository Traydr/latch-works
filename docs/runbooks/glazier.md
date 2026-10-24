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

## Using it

The sidebar has four views:
- **Tidy**: the to-do list, in the order the work should happen. Duplicates come first, then
  Convert, Silent tracks and Clean up, and finally what needs a look.
- **Duplicates**: the review queue.
- **Library**: every file, with filters.
- **History**: every change, plus the holding folder.

Settings is a sheet, opened with ⌘,. Press `?` anywhere for the keyboard shortcuts.

In **Duplicates**, each set (one picture or video and every version of it) arrives with a keeper
already chosen and the reason shown ("most pixels", "preferred folder"). The keys:

| Key | Action |
| --- | --- |
| Return | Resolve the set and move to the next |
| 1–9 | Keep a different version instead |
| ⇧1–9 | Keep that version as well |
| ⌘Return | Resolve every remaining set |
| S | Skip the set |
| N | Mark the set as not duplicates (it stays hidden; Dismissed lists them) |
| P | Prefer the focused version's folder, so every set keeps its copy there first |
| Z | Compare at 100% |

Byte-identical copies are one version, so a file appears in one set only.

## Actions that change the archive

Every change applies at once and ends with a toast that has **Undo**. ⌘Z undoes the last
change, and History lists them all. The one exception is a change that would remove a copy from
a preferred folder: that asks first.

Before each step, Glazier re-reads the file and skips it if its size, mtime or ctime moved since
the scan. Undo reverses a change's finished steps, newest first.

| Action | What happens on disk | Undo |
| --- | --- | --- |
| Move to holding (and resolving duplicates) | The file is renamed into `<root>/.glazier-holding/<batch>/<its path>`. | Renamed back, unless something now sits at the original path. |
| Clean up (Tidy) | System junk goes to holding, empty folders are removed, and extensions that do not match the bytes are renamed (an AVIF saved as `.jpg` becomes `.avif`). | Each step is reversed. |
| Move to… / Rename / Fix extension | Renamed in place, or moved to the chosen folder (copied then deleted across volumes, keeping mtime). | Moved back. |
| Convert to AVIF | The AVIF is written to `<target>.glazier-tmp`, checked (decodes, same dimensions, at least 5% smaller), given the original's mtime and renamed into place; the original goes to holding. | The AVIF goes to holding and the original comes back. |
| Animation, video → MP4; re-encode; remove audio | As above, through the Mediabunny transcoder window, or through ffmpeg when Mediabunny cannot handle the file. The result is checked with ffprobe (video track, duration, dimensions, audio kept or dropped as planned). Re-encodes must save 5%; container moves only need to succeed. | As above. |
| Restore (History › Held files) | The held file is renamed back to its original path. | — |
| Empty to Trash (History) | After a confirmation, each holding batch folder goes to the system Trash (`shell.trashItem`; the Recycle Bin on Windows). | Only from the Trash. |

A file whose conversion came out no smaller is kept as it is, and Convert stops offering it
until its bytes change. Extra copies of exact duplicates are not converted either: resolve them
first.

The original's creation date and extended attributes (Finder tags) are not carried over to a
converted file; its modification date is, so date sorting in Frame View and Pane View holds.

### Quitting, crashes and forced quits

Closing the window quits Glazier on every platform, and stops any ffmpeg it started. A change
cut short is marked **stopped** on the next launch, and any `*.glazier-tmp` file beside its
pending targets is deleted. Its finished steps stay finished and can be undone.

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
- **Re-encoding** to HEVC or AV1 is only done when asked: in the Library, select videos and
  choose More… › Re-encode as. It uses Chromium's WebCodecs through Mediabunny, so it gets the
  machine's hardware encoders; Settings › Encoders lists them. Older devices cannot play AV1.
- **When Mediabunny fails**, ffmpeg converts the file instead. Mediabunny cannot read MPEG-4
  Part 2, and it rejects some odd frame sizes; it can also produce a file that fails the checks.
  The fallback is the bundled `ffmpeg-static` with libx264, libx265 or SVT-AV1, cropping odd
  sizes to even. The step in History then says "Converted with ffmpeg (…)" with Mediabunny's
  error.

## Similar media

After every scan and every change, Glazier runs two analyses in the background:
- It fingerprints every image (a 64-bit DCT perceptual hash) and every video and animation
  (hashes of the frames at 10/30/50/70/90% of its duration).
- It measures each soundtrack's loudness. A track whose loudest moment stays below −60 dBFS
  counts as silent.

Background work waits behind anything you ask for and pauses while it runs. The status bar
shows its progress and can pause or stop it. Settings › Background analysis turns it off, after
which Tidy offers the two analyses as buttons. Results are cached against each file's
fingerprint, so a rescan only reads new or changed files.

Similar matches need the same aspect ratio (within 3%) and, for video, the same duration (within
1.5 s or 3%). The strictness levels are Strict, Balanced and Loose.

## Troubleshooting

- **A root shows "is not available"**: its drive is not mounted. The catalog is kept; rescan once
  it is back.
- **Video conversions fail with no encoder**: Settings › Encoders shows what WebCodecs offers
  and whether ffmpeg is there. Glazier keeps hardware acceleration on for this; nothing else is
  needed.
- **A step was skipped as "changed since the scan"**: rescan the root and apply again.
