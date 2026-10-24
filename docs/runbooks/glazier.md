# Glazier Runbook

Glazier is the desktop workbench for auditing and tidying a local archive: it reports what a root
holds, finds exact and similar duplicates, tells silent videos from ones with sound, and converts
files to the archive formats (AVIF for stills, MP4 for everything that moves). The plan that
introduced it is [058](../plans/058-glazier.md). It now ships as Tidy, one of Oriel's three
modes ([059](../plans/059-one-desktop-app.md)); its code lives in `apps/oriel/src/modes/tidy`.

## Run it

```sh
pnpm install
pnpm -r --filter './packages/*' build   # Oriel bundles workspace packages from their dist
pnpm --filter @latch-works/oriel start  # then ⌘2, or Tidy in the switcher
```

`pnpm --filter @latch-works/oriel package` builds the production app into `apps/oriel/out`;
`make` produces the DMG and ZIP. The macOS signing identity comes from
`ORIEL_MACOS_SIGN_IDENTITY`; without it the build is signed ad hoc (see
[electron-macos-signing.md](../electron-macos-signing.md)). Tidy's pages are on ⌥⌘1–7, since
⌘1–3 switch Oriel's modes.

## Where its data lives

| What | Where | Notes |
| --- | --- | --- |
| Catalog (SQLite) | `~/.latch-works/glazier/catalog.sqlite` | Rebuildable from the archive by rescanning. Never authoritative. |
| Thumbnails | `~/.latch-works/glazier/thumbnails/` | Safe to delete. |
| Holding | `~/.latch-works/glazier/holding/<root id>-<root name>/<batch>/<original path>` | Removed files and replaced originals, outside the root. A root on another volume holds in `<volume>/.latch-works/glazier/holding/<root id>-<root name>/` instead, so a removal stays a rename; a root that is a whole volume holds in the data folder by copying. |

Scanning never writes inside a root. The catalog and thumbnails are the only things a scan
creates. The other apps' folders sit beside Glazier's under `~/.latch-works` (see
[Local data](../ARCHITECTURE.md#local-data)).

Builds before kept this folder in `~/Library/Application Support/Glazier`. The first start of a
newer build renames it to `~/.latch-works/glazier`, and the catalog rewrites where each held file
is, so Restore and Undo still find them. If the rename fails (a second copy of Glazier holding the
catalog open, say), Glazier keeps using the old folder and tries again next start.

## Using it

**Choose folder…** (⌘O, or **Add Folder…** in the folder menu) opens Glazier's own folder picker
rather than the system's. Type or paste a path into its field, or start from Home, its usual
folders or a drive on the left. The list shows the folders inside what is typed and narrows as a
name is typed: ↑ and ↓ highlight one, Return or Tab opens it, and Return with nothing highlighted
(or ⌘Return) chooses. Hidden and system folders, `.latch-works` among them, are not listed. Move
in Library and **Prefer a folder** in Settings use the same picker, kept inside the root.
Dropping a folder on the window adds it too.

The sidebar lists the work in the order it is best done, then the archive:
- **Overview**: what tidying would do, with one **Tidy up** button (⌘↩). It runs Clean up,
  removes silent soundtracks and converts, in that order, as one change with one Undo. Each row
  opens its own page. Duplicates are never a step, identical copies included: a card under it
  opens the similar sets and another the identical ones, for you to decide.
- **Duplicates**: the review queue, with a Similar and an Identical tab.
- **Convert**: the files that would become AVIF or MP4, and why the rest are left as they are.
- **Clean up**: silent soundtracks, junk files, empty folders and wrong extensions.
- **Library**: every file, with search, one Filter menu, a list or a grid, and an inspector (I).
- **History**: every change, with Undo.
- **Holding** and **Settings** sit at the foot of the sidebar.

Under 1180 px the sidebar is a rail of icons, wide enough on macOS to hold the window buttons; ⌘\
switches between the rail and the full sidebar, and the choice is remembered for narrow and wide
windows separately. Press `?` anywhere for the keyboard shortcuts.

In **Duplicates**, a set shows every version at once, each under its whole folder path, wrapped
rather than cut, with the file name only where two versions share a folder. Identical copies list
their folders the same way, each with a checkbox: check more than one to keep the copy in each
folder (the copies kept are still identical, so they come back as a set to review later). Every
version and copy has a folder button that shows it in Finder. Similar versions take a checkbox too,
for alternates that only look alike (translated pages, a textless edit, a re-cut video): check each
one to keep, and Return holds the rest. A video plays in its tile, with its sound, from the controls
over it, one at a time, so versions can be checked for length and soundtrack by ear. The facts under
it say "sound", "silent" or "no sound track", or "sound not checked" when the loudness pass has not
measured it. The suggested keeper carries a violet ring and **Keep**; hovering the badge says what
decided it ("Keeping 1: most pixels (1600×1067 against 800×533)"). Each decision shows a toast with
**Undo** for a few seconds. When only a tie-breaker decided (a file a few bytes larger, the oldest,
the shortest path), the set is a **close call**: the keeper is only **Suggested**, an amber dot
marks it in the queue, and **Keep N suggestions** leaves it for you. Identical copies have no
keep-everything button: which copy to keep depends on where each one is, so each set is decided on
its own. The keys:

| Key | Action |
| --- | --- |
| Return | Keep the suggestion and go on to the next set |
| 1–9, or a click on a version | Keep only that version and go on |
| ⇧1–9, ⇧-click or its checkbox | Keep that version as well, or not |
| N | Keep every version (not duplicates, or **Keep both** for identical copies); the set stays hidden |
| S | Skip the set |
| Space (or C, or the ⤢ on a version) | Look closer: one version over the whole window; ← and → flip between them, ↩ keeps the one shown, Z (or a click) shows actual size |
| ⌘Y | Quick Look |
| ⇧⌘R (or the folder button) | Show the version in Finder |
| P | Prefer the focused version's folder, so every set keeps its copy there first |
| ⌘Return | Keep every similar-version suggestion, close calls excepted |
| ⌘Z | Undo the last decision and go back to that set |

Byte-identical copies are one version, so a file appears in one set only. Convert leaves the
members of open duplicate sets alone until they are reviewed, and while background analysis is
on, files not yet checked for similar versions too, so review never compares a converted copy.

## Actions that change the archive

Every change applies at once and ends with a toast that has **Undo**, duplicate decisions
included. ⌘Z undoes the last change, and History lists them all. Nothing asks
first, except forgetting a folder, which also moves its held files to the Trash.

Before each step, Glazier re-reads the file and skips it if its size, mtime or ctime moved since
the scan. Undo reverses a change's finished steps, newest first.

| Action | What happens on disk | Undo |
| --- | --- | --- |
| Move to holding (and resolving duplicates) | The file is moved into its root's holding folder (see the table above), under `<batch>/<its path>`. | Moved back, unless something now sits at the original path. |
| Clean up | System junk goes to holding, empty folders are removed, and extensions that do not match the bytes are renamed (an AVIF saved as `.jpg` becomes `.avif`). | Each step is reversed. |
| Move to… / Rename / Fix extension | Renamed in place, or moved to the chosen folder (copied then deleted across volumes, keeping mtime). | Moved back. |
| Convert to AVIF | The AVIF is written to `<target>.glazier-tmp`, checked (decodes, same dimensions, at least 5% smaller), given the original's mtime and renamed into place; the original goes to holding. | The AVIF goes to holding and the original comes back. |
| Animation, video → MP4; re-encode; remove audio | As above, through the Mediabunny transcoder window, or through ffmpeg when Mediabunny cannot handle the file. The result is checked with ffprobe (video track, duration, dimensions, audio kept or dropped as planned). Re-encodes must save 5%; container moves only need to succeed. | As above. |
| Restore (Holding, ⌘⌫) | The held file is moved back to its original path. | — |
| Empty to Trash (Holding, ⇧⌘⌫) | Each holding batch folder goes to the system Trash (`shell.trashItem`; the Recycle Bin on Windows), without asking: the Trash is the safety net. | Only from the Trash. |

A file whose conversion came out no smaller is kept as it is, and Convert stops offering it
until its bytes change. Members of open duplicate sets are not converted either: review them
first.

The original's creation date and extended attributes (Finder tags) are not carried over to a
converted file; its modification date is, so date sorting in Frame View and Pane View holds.

### Quitting, crashes and forced quits

Closing Oriel's window while a change is applying or being undone hides the window, and Oriel
quits once the change has finished; quitting again in the meantime quits at once. Otherwise
closing the window quits on every platform, and stops any ffmpeg Tidy started. A change cut short
is marked **stopped** on the next launch, and any `*.glazier-tmp` file beside its
pending targets is deleted. Its finished steps stay finished and can be undone.

## Lockstep and Pane View afterwards

Glazier never talks to Pane View. To bring the web library in line after a plan:

```sh
lockstep plan   # converted files show as new paths, their originals as missing
lockstep push
lockstep prune  # soft-deletes the missing paths in Pane View
```

Pane View keeps the old originals in its bucket and in Shutter until a deleted-item purge, as
always. Holding is never synced, because it is outside the root. `.latch-works` is in
`media-domain`'s system folder list, so Lockstep's scan and Frame View skip a volume's holding
folder, and the whole of `~/.latch-works`, when they scan a whole volume or a home folder.

Catalogs from before held inside the root, in `<root>/.glazier-holding` (a name the scanners still
skip). When Glazier starts it
moves those files to the new holding folder and removes the emptied old folder; a held file that
was deleted by hand is recorded as gone. A root that is not mounted is moved on a later start. If
Lockstep pushed the old folder, `lockstep plan` shows its paths as missing once it is gone and
`lockstep prune` removes them from Pane View.

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

Background work waits behind anything you ask for and pauses while it runs. The job card at the
foot of the sidebar shows its progress and can pause or stop it. Settings › Background analysis
turns it off, after which Overview offers **Check now**. Results are cached against each file's
fingerprint, so a rescan only reads new or changed files.

Similar matches need the same aspect ratio (within 3%) and, for video, the same duration (within
1.5 s or 3%). The strictness levels are Strict, Balanced and Loose.

## Troubleshooting

- **A root shows "is not available"**: its drive is not mounted. The catalog is kept; rescan once
  it is back.
- **Video conversions fail with no encoder**: Settings › Encoders shows what WebCodecs offers
  and whether ffmpeg is there. Oriel keeps hardware acceleration on for this unless
  `ORIEL_DISABLE_GPU` is set; nothing else is needed.
- **A step was skipped as "changed since the scan"**: rescan the root and apply again.
