# Oriel RS against Electron Oriel: what is ported

This page lists what Electron Oriel does, area by area, and how much of each feature Oriel RS has,
checked against `apps/oriel-rs/crates` at commit `4eec485b` (2026-10-28). The answer to "is
everything in the Electron version implemented?" is no, as the plan expects, since Phases 0 and 1
built only the foundations and Phases 2 to 8 bring the features. Today Oriel RS has the shell's
frame, a View that lists a folder and shows its stills and videos, and the rules its engines will
use, while Tidy's engine and pages, Sync, the links between modes and Settings are not started.

## How much is done

| Area | Features | Done | Partial | Not started | Phase |
|---|---:|---:|---:|---:|---|
| [Shell](#shell) | 14 | 4 | 3 | 7 | 2 |
| [View](#view) | 23 | 4 | 3 | 16 | 3 |
| [Tidy's engine](#tidys-engine) | 16 | 0 | 4 | 12 | 5 and 6 |
| [Tidy's pages](#tidys-pages) | 15 | 0 | 2 | 13 | 7 |
| [Sync](#sync) | 7 | 0 | 0 | 7 | 4 |
| [Links between the modes](#links-between-the-modes) | 6 | 0 | 0 | 6 | 7 |
| [Settings](#settings) | 7 | 0 | 1 | 6 | 2, 3, 4 and 7 |
| [Packaging and updates](#packaging-and-updates) | 7 | 0 | 1 | 6 | next, or none yet |
| [Windows](#windows) | 7 | 0 | 0 | 7 | 8 |
| **All** | **102** | **8** | **14** | **80** | |

Of Oriel's 33 e2e cases, the plan's parity list, 2 pass as GPUI tests, 6 are partly built, 24
wait on their features, and 1 does not apply ([the parity list](#the-parity-list)).

The states mean this:
- **Done**: it works in Oriel RS as it does in Electron Oriel.
- **Partial**: some of it works. For Tidy's engine, which has no screen yet, that means part of
  its code is ported and tested.
- **Not started**: none of it is in the app. Where a rule it needs is already ported, the row says
  so.

The inventory comes from the e2e specs in `e2e/tests/`, the runbooks
([Oriel](../../runbooks/oriel.md), [Tidy](../../runbooks/glazier.md),
[Sync](../../runbooks/lockstep.md)), [plan 059](../../plans/059-one-desktop-app.md), and
`apps/oriel/src` where those are thin. A few things are left out on purpose, as
[not ported on purpose](#not-ported-on-purpose) explains.

## Shell

| Electron Oriel | State | In Oriel RS | Phase |
|---|---|---|---|
| One window, a transparent title bar, the window buttons inset | Done | 1320 × 860, at least 960 × 640, as Electron Oriel's first window | 0 |
| View · Tidy · Sync switcher in the sidebar's header, ⌘1–3, stacked icons in the rail | Done | A segmented control, or three icons in the rail; a GPUI test presses ⌘1–3 | 0 |
| Hidden modes keep their state, and keys reach only the mode on screen | Done | A hidden mode's entity lives on and is not drawn; a GPUI test checks Tidy's page | 0 |
| Light and dark house theme | Done | Oriel Light and Oriel Dark from the `lw-*` tokens, following the system | 0 |
| Full sidebar or rail, from ⌘\ or the top bar's toggle | Partial | Both toggles work in every mode; the choice is not remembered | 2 |
| Native menu with the mode's own File, Edit and View items, a check mark on the mode, Settings…, Toggle Full Screen | Partial | One fixed menu: the app menu, File (Close Window), Edit, View (the three modes, Toggle Sidebar), Window | 2 |
| Closing the window quits, unless a push or a Tidy change runs; then it hides and quits when the work ends | Partial | Closing quits; nothing runs yet that it must wait for | 2 |
| The window title follows the mode ("View – Oriel") | Not started | Always "Oriel RS" | 2 |
| Window size and position, the last mode and the last page come back on launch | Not started | Starts in View at the default size | 2 |
| Toasts | Not started | | 2 |
| Activity on the switcher: a ring while a push or Tidy change runs, a dot while a scan or analysis does | Not started | | 2 |
| Dock progress while a run goes on | Not started | | 2 |
| Files and folders the OS opens with the app, or a second launch hands over, open in View | Not started | `ORIEL_RS_OPEN` opens a folder at start, for measuring | 2 |
| VoiceOver reads the switcher, the sidebar and the top bar by name | Not started | Never checked with VoiceOver; the switcher and sidebar items set no accessible names | 2 |

## View

| Electron Oriel | State | In Oriel RS | Phase |
|---|---|---|---|
| A virtual gallery grid, tiles sized as `useVirtualGridMetrics.ts` sizes them | Done | `uniform_list` rows; Phase 0 measured it | 0 |
| Still thumbnails: WebP at the broker's sizes, under its cache key | Done | ImageIO decodes, libwebp encodes, a bounded image cache draws them | 0 |
| The viewer: ← and →, Q and E, the step buttons, Escape; neighbours decoded ahead | Done | A GPUI test steps and closes it; it always wraps at the ends | 0 |
| The capsule player: play and pause, back and forward 5 s, the scrubber, mute | Done | libmpv by default, AVPlayer as the fallback; no GPUI test yet | 0 and 1 |
| Open a folder with ⌘O, the Open button, or a drop on the window | Partial | The Open button and the system's folder picker | 3 |
| Sort: A–Z, Z–A, Newest, Oldest, and Random with Shuffle | Partial | The gallery sorts A–Z only; `core-domain` ports every order, pinned by vectors | 3 |
| Player keys: Space or 2 plays, 1 and 3 skip, M mutes, and ← → still step | Partial | Space, M, and ← → skip 5 s while a video has focus | 3 |
| A media index: a SQLite catalog of each root, scanned in a worker, with progress and cancel | Not started | Each open lists the folder again on a background thread; no database | 3 |
| A folder shows its own children: subfolders as tiles, then its media, with both counts | Not started | Every media file under the folder, listed recursively, with an item count | 3 |
| Recursive on demand (the Recursive button) | Not started | Always recursive | 3 |
| The folder browser (Folders): include or exclude each child of the root, kept per root | Not started | | 3 |
| Sidebar: the folder on screen, its parent and its subfolders; ⇧A, ⇧D and ⇧W step between folders | Not started | View's sidebar holds only the switcher | 3 |
| Filters: show images, show videos | Not started | | 3 |
| Video thumbnails (an ffmpeg frame) and durations (ffprobe) | Not started | Video tiles show a VIDEO badge on a blank tile | 3 |
| The thumbnail cache capped at 5,000 files | Not started | The cache has no cap | 3 |
| Thumbnail size slider in the toolbar | Not started | Fixed at 220 px | 3 |
| Video autoplays on hover, with optional sound | Not started | | 3 |
| Keyboard focus through the grid: arrows or WASD move, Enter or F opens | Not started | A click selects, a double-click opens | 3 |
| The viewer's Copy path, Reveal in folder, Show in Tidy and full screen | Not started | The name, size and format, and a close button | 3 and 7 |
| The player's volume level, playback speed, held 4 for a temporary speed, loop | Not started | Mute only | 3 |
| Comic mode, with leaf folders as comics, and the comic reader | Not started | `core-domain` groups comics as `media-domain` does, pinned by vectors | 3 |
| The last folder, and the folder it was opened at, come back on launch | Not started | | 3 |
| Refresh (⌘R) | Not started | | 3 |

## Tidy's engine

`glazier-core` is about 10.6k lines of TypeScript. Oriel RS has ported the fingerprints and the
policies the engine applies, and the runtime it will run on.

| Electron Oriel | State | In Oriel RS | Phase |
|---|---|---|---|
| Fingerprints (64-bit hash) and detail prints of stills, animations and videos | Partial | Ported in `core-tidy`, bit for bit on the corpus; not yet run as a pass | 5 |
| Similar groups (Strict, Balanced, Loose) and Spot variants | Partial | The print comparisons, `is_variant` among them; not the grouping | 5 |
| Convert stills to AVIF, checked, with the original's date | Partial | `core-format` ports the policy and the AVIF settings; libavif measured in `crates/bench`; nothing encodes | 6 |
| Convert video and animations to MP4, remove silent soundtracks, re-encode as HEVC or AV1 | Partial | `core-format` ports the video, audio and animation decisions; nothing encodes | 6 |
| The catalog: SQLite, its schema and migrations | Not started | The SQLite thread and the `user_version` migrations it will use, in `oriel-runtime` | 5 |
| Roots: add, rescan, forget (held files to the Trash), "not available" while unmounted | Not started | | 5 |
| The scan: walk, sniff types, skip junk, hash files that share a size | Not started | The junk rules are in `core-domain`; Phase 0 measured a walk and SHA-256 in `crates/bench` | 5 |
| The probe pass (ffprobe) and the loudness pass (silent below −60 dBFS) | Not started | `oriel-tools` runs the pinned ffprobe and ffmpeg | 5 |
| Identical sets, the keeper choice and close calls | Not started | | 5 |
| Background analysis: behind asked-for work, pause and stop, results cached per file | Not started | The job runtime it will use, in `oriel-runtime` | 5 |
| The planner, the executor (it re-reads each file first), holding outside the root, the journal, Undo per step, stopped changes cleaned up on launch | Not started | `core-paths` keeps Tidy roots inside the sandbox | 6 |
| Clean up: junk to holding, empty folders removed, wrong extensions renamed | Not started | | 6 |
| Shrink: SVT-AV1 at CRF 35, the estimate, the timings it learns, batches that stop and resume | Not started | | 6 |
| Tidy up: Clean up, silent soundtracks and Convert as one change with one Undo | Not started | | 6 |
| Rename, Move to… and Fix extension | Not started | | 6 |
| Thumbnails for Tidy's tiles and rows | Not started | | 7 |

## Tidy's pages

| Electron Oriel | State | In Oriel RS | Phase |
|---|---|---|---|
| The sidebar: the pages in order, Holding and Settings at the foot, the folder menu, ⌥⌘1–7 | Partial | The eight pages switch from the sidebar; no keys, folder menu or Settings entry | 7 |
| The Library's table: sort, scroll, select | Partial | GPUI Kit's data table, measured with 100,000 synthetic rows; it shows only when the Phase 0 spike asks | 7 |
| "Choose your media archive" when Tidy has no folder | Not started | | 7 |
| Tidy's own folder picker (a typed path, the usual folders, drives, keys), and a dropped folder | Not started | | 7 |
| Overview: what tidying would do, Tidy up (⌘↩), Check now | Not started | Every page but the Library's spike is a placeholder | 7 |
| Duplicates: the queue (Similar, Identical, Variants, Not duplicates), the version grid with playing tiles, the copy list, the loupe | Not started | | 7 |
| Duplicates' keys: Return, 1–9, ⇧1–9, N, S, Space, ⌘Y Quick Look, ⇧⌘R, P, ⌘Return, ⌘Z; Undo toasts; the Spot variants switch | Not started | | 7 |
| Convert | Not started | | 7 |
| Clean up | Not started | | 7 |
| Shrink | Not started | | 7 |
| The Library's search, Filter menu, list or grid, Inspector (I), rename field, selection bar and More… | Not started | | 7 |
| History, with Undo | Not started | | 7 |
| Holding: Restore (⌘⌫) and Empty to Trash (⇧⌘⌫) | Not started | | 7 |
| The job card at the sidebar's foot: progress, pause, stop | Not started | | 7 |
| Tidy's menu items (Add Folder… ⌘O, Rescan ⌘R, Undo ⌘Z, Select All, Find ⌘F) and the shortcut sheet (?) | Not started | | 7 |

## Sync

| Electron Oriel | State | In Oriel RS | Phase |
|---|---|---|---|
| Profiles in the sidebar: add, edit, delete, each with a source folder, a Pane View URL and a token | Not started | A placeholder page | 4 |
| The token stored with AES-256-GCM under a 0600 key file, never in the settings file in the clear | Not started | | 4 |
| Check connection (the doctor) | Not started | | 4 |
| Plan: the source against Pane View's snapshot, with the hash cache, shown as the plan tree | Not started | | 4 |
| Push through a bounded upload queue, with the run panel's progress, throughput and Cancel | Not started | The tokio thread its HTTP will run on, in `oriel-runtime` | 4 |
| Prune: once per plan, confirming the count, skipping a file that is back in the source | Not started | | 4 |
| The run log (⌘L), and the last run under the profile's name | Not started | | 4 |

## Links between the modes

| Electron Oriel | State | In Oriel RS | Phase |
|---|---|---|---|
| A folder one mode works on is offered in the others' empty states | Not started | | 7 |
| Open in View from Tidy's Library, Inspector, duplicate tiles, copies, loupe and Overview | Not started | | 7 |
| Show in Tidy from the viewer | Not started | | 7 |
| Sync this folder from Tidy's Overview | Not started | | 7 |
| Open in View and Tidy this folder from Sync's profile menu | Not started | | 7 |
| A file handed to View opens in the viewer once its folder is scanned | Not started | | 7 |

## Settings

| Electron Oriel | State | In Oriel RS | Phase |
|---|---|---|---|
| General: the theme (System, Light, Dark) | Partial | Follows the system, with no choice | 2 |
| One Settings page (⌘,), opened at the mode's section from the bottom left of every sidebar; Escape closes it | Not started | | 2 |
| General: the data folder | Not started | `ORIEL_RS_DATA_DIR` moves it | 2 |
| View: remember the last folder, recursive by default, autoplay on hover and in the viewer, loop viewer navigation, sound in previews, loop videos, show images and videos | Not started | | 3 |
| View's Diagnostics: index and thumbnail counts, clearing them, ffmpeg's status, worker events | Not started | | 3 |
| Tidy: preferred folders, Convert's options and video quality, background analysis, similar versions, Spot variants, encoders, how long each run takes | Not started | | 7 |
| Sync: the profiles and where tokens are kept | Not started | | 4 |

## Packaging and updates

| Electron Oriel | State | In Oriel RS | Phase |
|---|---|---|---|
| ffmpeg and ffprobe bundled at pinned hashes | Partial | `oriel-tools` fetches the same pins into a development cache and refuses a mismatch; nothing bundles them | next |
| A `.app` with its icon, opened from Finder | Not started | `cargo build --release` makes an 18.5 MB binary | next |
| Its native libraries inside the app | Not started | libvips loads from `node_modules`, and libmpv from IINA (GPL, never to ship) | next |
| Signed ad hoc, or with `ORIEL_MACOS_SIGN_IDENTITY` | Not started | | next |
| A designed DMG and a ZIP, from `pnpm make:oriel` | Not started | | none yet |
| An offer to move to Applications when started from elsewhere | Not started | | none yet |
| A build workflow that makes the DMG and Setup.exe as artifacts | Not started | `oriel-rs.yml` runs the checks only | none yet |

Neither app has auto-update or a notarized release. Both plans leave signing, notarization and
auto-update as follow-ups.

## Windows

| Electron Oriel | State | In Oriel RS | Phase |
|---|---|---|---|
| A Windows x64 build | Not started | `oriel-tools` already pins Electron Oriel's win32-x64 ffmpeg | 8 |
| Setup.exe and an MSI through Velopack | Not started | | 8 |
| The native caption buttons (`titleBarOverlay`) | Not started | | 8 |
| A single-instance lock | Not started | | 8 |
| Video playback | Not started | | 8 |
| AVIF on screen (Chromium decodes it) | Not started | | 8 |
| Plan 062's fixes: files held open, drives, long paths, names, hard links | Not started | | 8 |

## The parity list

Plan 063's parity list is Oriel's 33 e2e cases. Each phase ports its cases to GPUI Kit's headless
UI tests. A case counts here as written in its spec, so the loop over four sort orders is one.

| Case | State | Phase |
|---|---|---|
| **[`shell.spec.ts`](../../../e2e/tests/oriel/shell.spec.ts)** | | |
| Starts in View and switches modes from the switcher and the menu | Partial: the keys, the switcher and the View menu switch; the title and a check mark do not follow | 2 |
| Reopens in the mode it showed last | Not started | 2 |
| Reopens on the page it showed last, with View able to step back up | Not started | 2 |
| View keeps its folder while another mode shows | Partial: hidden modes keep their state; the GPUI test checks Tidy's page, not View's folder | 2 |
| One Settings page, at the section of the mode on screen | Not started | 2 |
| **[`gallery.spec.ts`](../../../e2e/tests/frame-view/gallery.spec.ts)** | | |
| Opens a folder, lists its children, and recurses on demand | Partial: it lists recursively at once, with no list of children or Recursive button | 3 |
| Excluding a root child drops its subtree from the recursive scan | Not started | 3 |
| Filters hide videos and images | Not started | 3 |
| A fresh scan lands in the configured sort order | Partial: A–Z, the default, is the only order | 3 |
| A–Z, Z–A, Newest and Oldest match the shared ordering rules | Partial: A–Z in the gallery; all four in `core-domain`'s vectors | 3 |
| Random is a permutation and Shuffle changes it | Not started: Random's order is in the vectors, but the gallery has no Random or Shuffle | 3 |
| Every image tile renders a thumbnail | Done, as a GPUI test | 3 |
| Double-click opens the viewer, the arrows step, and Escape closes | Done, as a GPUI test | 3 |
| A video opens in the capsule player: seek, skip, mute and play or pause | Partial: every control works; no GPUI test, and no autoplay setting to turn off | 3 |
| Comic mode groups leaf folders and the reader opens one | Not started | 3 |
| A relaunch restores the remembered folder | Not started | 3 |
| **[`e2e/tests/glazier/`](../../../e2e/tests/glazier/)**, nine cases | | |
| A new folder is scanned and Overview lists what to do with it | Not started | 5 and 7 |
| The resized JPEG is grouped with the picture it came from | Not started | 5 and 7 |
| Silent tracks are told apart from sound | Not started | 5 and 7 |
| Return keeps the suggested copy and moves on, and Undo brings the set back | Not started | 6 and 7 |
| Convert turns stills into AVIF and video into MP4, keeping dates | Not started | 6 and 7 |
| Clean up fixes the extension, holds the junk and removes the empty folder | Not started | 6 and 7 |
| Shrink re-encodes a busy video to AV1, leaves a compact one, and Undo restores it | Not started | 6 and 7 |
| Tidy up runs every step but duplicates as one change, and one Undo takes it all back | Not started | 6 and 7 |
| Spot variants keeps each picture once and moves sets of variants out of review | Not started | 5 and 7 |
| **[`sync.spec.ts`](../../../e2e/tests/lockstep/sync.spec.ts)**, five cases | | |
| A profile is created against the running Pane View | Not started | 4 |
| Plan reports the source as uploads, and push lands them in Pane View | Not started | 4 |
| A second plan has nothing to upload | Not started | 4 |
| Prune deletes the reviewed plan's deletes once, skipping a file back in the source | Not started | 4 |
| The sync token never reaches the settings file in the clear | Not started | 4 |
| **[`e2e/tests/oriel/`](../../../e2e/tests/oriel/)**, the rest | | |
| A folder Tidy tidies is offered to View, and the modes hand files and folders on (`links.spec.ts`) | Not started | 7 |
| The first start's welcome sets one folder up for View and Tidy (`welcome.spec.ts`) | Not started | 7 |
| The first start brings the old apps' preferences and window over (`migration.spec.ts`) | Does not apply | |

## Not ported on purpose

- **The old apps' data.** Electron Oriel's first start brings Frame View's, Glazier's and
  Lockstep's data and tokens over, offers to remove the old apps, and refuses to run Tidy beside
  the old Glazier. Oriel RS keeps its own data (decision 2), so none of that applies, and neither
  does File › Import from the Old Apps….
- **Electron's processes.** Tidy's engine host, AVIF pool, transcoder window and IPC go, since the
  engine runs on background threads.
- **Mediabunny and WebCodecs.** Convert encodes through ffmpeg instead, so Settings › Encoders has
  nothing to list. ffmpeg's hardware encoders are a follow-up.
- **PDFs.** Electron Oriel's View does not read them either (plan 040).
