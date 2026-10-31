# Oriel RS against Electron Oriel: what is ported

This page lists what Electron Oriel does, area by area, and how much of each feature Oriel RS has,
checked against `apps/oriel-rs/crates` at commit `31aa7326` (2026-10-31). After the parity round of
2026-10-31 everything Electron Oriel does on macOS is ported. The exceptions are a VoiceOver pass by
a person, and the build workflow the owner chose not to have (decision 20). Oriel RS also imports
Electron Oriel's data. Windows builds and passes clippy for `x86_64-pc-windows-gnullvm`, but
nothing has run on Windows yet; [the Windows runbook](../../runbooks/oriel-windows.md) hands it
over. 32 of Oriel's 33 e2e cases run as GPUI tests.

## How much is done

| Area | Features | Done | Partial | Not started | Phase |
|---|---:|---:|---:|---:|---|
| [Shell](#shell) | 14 | 13 | 1 | 0 | 2 |
| [View](#view) | 23 | 23 | 0 | 0 | 3 |
| [Tidy's engine](#tidys-engine) | 16 | 16 | 0 | 0 | 5 and 6 |
| [Tidy's pages](#tidys-pages) | 15 | 15 | 0 | 0 | 7 |
| [Sync](#sync) | 7 | 7 | 0 | 0 | 4 |
| [Links between the modes](#links-between-the-modes) | 7 | 7 | 0 | 0 | 7 |
| [Settings](#settings) | 7 | 7 | 0 | 0 | 2, 3, 4 and 7 |
| [Packaging and updates](#packaging-and-updates) | 8 | 7 | 0 | 0 | after 1, and the parity round |
| [Windows](#windows) | 7 | 0 | 7 | 0 | 8 |
| **All** | **104** | **99** | **8** | **0** | |

Packaging's eighth row, the build workflow, is left on purpose (decision 20). Windows' rows are
Partial because they compile but have not run. [Importing Electron Oriel's
data](#importing-electron-oriels-data) is new in Oriel RS and is listed apart.

Of Oriel's 33 e2e cases, the plan's parity list, 32 pass as GPUI tests and 1 does not apply
([the parity list](#the-parity-list)).

The states mean this:
- **Done**: it works in Oriel RS as it does in Electron Oriel. A Done row can still name a
  deliberate deviation in its "In Oriel RS" cell; the rest are under
  [where Oriel RS differs on purpose](#where-oriel-rs-differs-on-purpose).
- **Partial**: some of it works, and the row says which part is missing.
- **Not started**: none of it is in the app.
- **Left on purpose**: the owner chose not to have it. What the plan sets aside and neither app
  has, notarization and auto-update, is under [not ported on purpose](#not-ported-on-purpose).

The inventory comes from the e2e specs in `e2e/tests/`, the runbooks
([Oriel](../../runbooks/oriel.md), [Tidy](../../runbooks/glazier.md),
[Sync](../../runbooks/lockstep.md)), [plan 059](../../plans/059-one-desktop-app.md), and
`apps/oriel/src` where those are thin. The welcome and About were missing from the last list and
are added. A few things are left out on purpose, as [not ported on purpose](#not-ported-on-purpose)
explains.

## Shell

| Electron Oriel | State | In Oriel RS | Phase |
|---|---|---|---|
| One window, a transparent title bar, the window buttons inset | Done | 1320 × 860, at least 960 × 640, as Electron Oriel's first window | 0 |
| View · Tidy · Sync switcher in the sidebar's header, ⌘1–3, stacked icons in the rail | Done | A segmented control, or three icons in the rail; Tab reaches it | 0 |
| Hidden modes keep their state, and keys reach only the mode on screen | Done | A hidden mode's entity lives on and is not drawn; the mode coming on screen takes the keys; its videos pause | 0 and 2 |
| Light and dark house theme | Done | Oriel Light and Oriel Dark from the `lw-*` tokens | 0 |
| Full sidebar or rail, from ⌘\ or the top bar's toggle | Done | Remembered under Electron's `oriel.sidebar` key | 2 |
| Native menu with the mode's own File, Edit and View items, a check mark on the mode, Settings…, Toggle Full Screen | Done | Every item of the mode on screen is lit; Window also has Bring All to Front | 2 |
| Closing the window quits, unless a push or a Tidy change runs; then it hides and quits when the work ends | Done | ⌘Q, ⌘W, the close button, the Dock's Quit and logging out all wait; a paused change does not | 2 |
| The window title follows the mode ("View – Oriel") | Done | "View – Oriel RS" | 2 |
| Window size and position, the last mode and the last page come back on launch | Done | `shell/window-state.json` in Electron's format and global coordinates, so it reopens on its display | 2 |
| Toasts | Done | GPUI Kit's notification look, one at a time; 5 s (Electron: 8 s), and errors stay until dismissed | 2 |
| Activity on the switcher: a ring while a push or Tidy change runs, a dot while a scan or analysis does | Done | "Tidy · 40% done" | 2 |
| Dock progress while a run goes on | Done | A violet bar (Electron's is blue); checked in a real window, with no automated test | 2 |
| Files and folders the OS opens with the app, or a second launch hands over, open in View | Done | Also a path given on the command line | 2 |
| VoiceOver reads the switcher, the sidebar and the top bar by name | Partial | Roles and names are set and pinned by tests; nobody has listened with VoiceOver | 2 |

## View

| Electron Oriel | State | In Oriel RS | Phase |
|---|---|---|---|
| A virtual gallery grid, tiles sized as `useVirtualGridMetrics.ts` sizes them | Done | `uniform_list` rows; 21,135 items scroll at p99 8.8 ms | 0 |
| Still thumbnails: WebP at the broker's sizes, under its cache key | Done | ImageIO decodes, libwebp encodes; kept at `view/frame-view/thumbnails` | 0 |
| The viewer: ← and →, Q and E, the step buttons, Escape; neighbours decoded ahead | Done | Wraps at the ends unless loop navigation is off | 0 and 3 |
| The capsule player: play and pause, back and forward 5 s, the scrubber, mute | Done | libmpv by default, AVPlayer as the fallback | 0, 1 and 3 |
| Open a folder with ⌘O, the Open button, or a drop on the window | Done | Also over the viewer and the comic reader, which a new folder closes | 3 |
| Sort: A–Z, Z–A, Newest, Oldest, and Random with Shuffle | Done | `core-domain`'s orders, pinned by vectors | 3 |
| Player keys: Space or 2 plays, 1 and 3 skip, M mutes, and ← → still step | Done | And 4, held for 2× | 3 |
| A media index: a SQLite catalog of each root, scanned in a worker, with progress and cancel | Done | `media-index.sqlite` with Electron's schema statements, on `oriel-runtime`'s SQLite thread | 3 |
| A folder shows its own children: subfolders as tiles, then its media, with both counts | Done | | 3 |
| Recursive on demand (the Recursive button) | Done | | 3 |
| The folder browser (Folders): include or exclude each child of the root, kept per root | Done | | 3 |
| Sidebar: the folder on screen, its parent and its subfolders; ⇧A, ⇧D and ⇧W step between folders | Done | | 3 |
| Filters: show images, show videos | Done | View also lists HEIC and HEIF, which ImageIO decodes | 3 |
| Video thumbnails (an ffmpeg frame) and durations (ffprobe) | Done | Electron's ffmpeg arguments and 12 s timeout | 3 |
| The thumbnail cache capped at 5,000 files | Done | Kept as Electron has it | 3 |
| Thumbnail size slider, in Settings | Done | | 3 |
| Video autoplays on hover, with optional sound | Done | One preview at a time, through libmpv; it starts after 200 ms of rest, where Electron starts at once | 3 |
| Keyboard focus through the grid: arrows or WASD move, Enter or F opens | Done | Wraps at the ends; ⇧S opens the first folder | 3 |
| The viewer's Copy path, Reveal in folder, Show in Tidy and full screen | Done | The controls fade after 2.5 s, and any key brings them back | 3 and 7 |
| The player's volume level, playback speed, held 4 for a temporary speed, loop | Done | Volume and mute under Electron's `frameview.viewer.*` keys; a volume drag is saved when let go | 3 |
| Comic mode, with leaf folders as comics, and the comic reader | Done | The reader decodes pages through ImageIO near the one in view; its top bar fades as the viewer's does | 3 |
| The last folder, and the folder it was opened at, come back on launch | Done | `frame-view-settings.json` in Electron's version-3 envelope | 3 |
| Refresh (⌘R) | Done | | 3 |

## Tidy's engine

`glazier-core` is about 10.6k lines of TypeScript, and `core-tidy` ports all of it. Both engines
scan and analyse the same archives to identical reports, the 21,136 files of `spike-fixture`
among them (`tests/differential.rs`), and every e2e Tidy case's changes and Undos leave the same
trees, holding and journal (`tests/changes.rs`). Tidy changes files in any folder the owner adds
(decision 18). A run with `ORIEL_RS_DATA_DIR` set, as checks and agents use, keeps the old sandbox:
roots under `<data>/sandbox` or the temp folder.

| Electron Oriel | State | In Oriel RS | Phase |
|---|---|---|---|
| Fingerprints (64-bit hash) and detail prints of stills, animations and videos | Done | Bit for bit on the corpus, through sharp's libvips | 5 |
| Similar groups (Strict, Balanced, Loose) and Spot variants | Done | glazier-core's thresholds and its Map insertion order | 5 |
| Convert stills to AVIF, checked, with the original's date | Done | Native libavif with aom (`oriel-avif`), making jSquash's calls; stills over 64 MP go to libavif too, not sharp | 6 |
| Convert video and animations to MP4, remove silent soundtracks, re-encode as HEVC or AV1 | Done | ffmpeg only, with Electron's fallback arguments; animations follow Mediabunny's decisions | 6 |
| The catalog: SQLite, its schema and migrations | Done | glazier-core's 9 migrations word for word; it reads a catalog glazier-core wrote | 5 |
| Roots: add, rescan, forget (held files to the Trash), "not available" while unmounted | Done | Forgetting refuses while a job runs on the root, as glazier-core does | 5 and 6 |
| The scan: walk, sniff types, skip junk, hash files that share a size | Done | Folders read in byte order, as Node's `readdir` reads them, so file ids match | 5 |
| The probe pass (ffprobe) and the loudness pass (silent below −60 dBFS) | Done | The pinned ffprobe and ffmpeg, through `oriel-tools` | 5 |
| Identical sets, the keeper choice and close calls | Done | | 5 |
| Background analysis: behind asked-for work, pause and stop, results cached per file | Done | One job for fingerprints, detail prints and loudness, where glazier-core runs separate jobs | 5 |
| The planner, the executor (it re-reads each file first), holding outside the root, the journal, Undo per step, stopped changes cleaned up on launch | Done | A root on another volume holds at that volume's top, in `.latch-works/oriel-rs/holding`, as glazier-core does with its own folder; Restore, Undo and Empty Holding touch only Oriel RS's holding places | 6 |
| Clean up: junk to holding, empty folders removed, wrong extensions renamed | Done | | 6 |
| Shrink: SVT-AV1 at CRF 35, the estimate, the timings it learns, batches that stop and resume | Done | | 6 |
| Tidy up: Clean up, silent soundtracks and Convert as one change with one Undo | Done | The page runs the steps one after another, as Electron's renderer does | 6 |
| Rename, Move to… and Fix extension | Done | In a sandboxed run, Move to… refuses a folder outside the sandbox | 6 |
| Thumbnails for Tidy's tiles and rows | Done | Kept in memory, the last 400 drawn and at most 200 MiB (decision 23), not on disk | 7 |

## Tidy's pages

| Electron Oriel | State | In Oriel RS | Phase |
|---|---|---|---|
| The sidebar: the pages in order, Holding and Settings at the foot, the folder menu, ⌥⌘1–7 | Done | The pages show even with no folder | 7 |
| The Library's table: sort, scroll, select | Done | GPUI Kit's data table; ⌘-click, ⇧-click and ⇧ with the arrows; columns drop at Electron's widths | 7 |
| "Choose your media archive" when Tidy has no folder | Done | It takes a dropped folder; a sandboxed run names the sandbox | 7 |
| Tidy's own folder picker (a typed path, the usual folders, drives, keys), and a dropped folder | Done | In a sandboxed run, places outside the sandbox are shown but locked | 7 |
| Overview: what tidying would do, Tidy up (⌘↩), Check now | Done | | 7 |
| Duplicates: the queue (Similar, Identical, Variants, Not duplicates), the version grid with playing tiles, the copy list, the loupe | Done | No Not duplicates list, at the owner's request: N marks a set, and Undo brings it back. Cleaned up at the owner's request (see [where Oriel RS differs](#where-oriel-rs-differs-on-purpose)); tiles play through libmpv and stop out of sight; the loupe shows actual pixels, up to 16384 px | 7 |
| Duplicates' keys: Return, 1–9, ⇧1–9, N, S, Space, ⌘Y Quick Look, ⇧⌘R, P, ⌘Z; Undo toasts; the Spot variants switch | Done | Quick Look shows one file at a time; Electron's Duplicates has no ⌘Return, so the row drops it | 7 |
| Convert | Done | | 7 |
| Clean up | Done | | 7 |
| Shrink | Done | With "How much each run takes", as in Electron | 7 |
| The Library's search, Filter menu, list or grid, Inspector (I), rename field, selection bar and More… | Done | The native menu writes its shortcuts into the item text | 7 |
| History, with Undo | Done | A run of duplicate decisions lists each with its own Undo, and Undo all N; kind icons, relative times; also lists "not duplicates" decisions, read from the catalog, with an Undo that sends the set back to review | 7 |
| Holding: Restore (⌘⌫) and Empty to Trash (⇧⌘⌫) | Done | Arrow keys and a Restore on each tile; Empty to Trash goes through NSFileManager, or the Recycle Bin on Windows | 7 |
| The job card at the sidebar's foot: progress, pause, stop | Done | Replaced at the owner's request by the shell's activity panel at the bottom right, for every mode, with Pause, Stop and a queue | 7 |
| Tidy's menu items (Add Folder… ⌘O, Rescan ⌘R, Undo ⌘Z, Select All, Find ⌘F) and the shortcut sheet (?) | Done | | 7 |

## Sync

| Electron Oriel | State | In Oriel RS | Phase |
|---|---|---|---|
| Profiles in the sidebar: add, edit, delete, each with a source folder, a Pane View URL and a token | Done | It reads the profiles Electron Oriel wrote | 4 |
| The token stored with AES-256-GCM under a 0600 key file, never in the settings file in the clear | Done | It opens the tokens Electron Oriel sealed; there are no session-only tokens | 4 |
| Check connection (the doctor) | Done | | 4 |
| Plan: the source against Pane View's snapshot, with the hash cache, shown as the plan tree | Done | The hash cache is lockstep-core's JSON; a Rust plan equals the Lockstep CLI's on four sources; it hashes 16 files at once (decision 22) | 4 |
| Push through a bounded upload queue, with the run panel's progress, throughput and Cancel | Done | Starts at 3 uploads at once and adds one, up to 6, while the gain holds for two windows; steps back when the link is full, or on a 429, a 5xx or a timeout (decision 22). A width set by hand stays fixed, 1 to 8. The throughput chart is bars, with failure markers | 4 |
| Prune: once per plan, confirming the count, skipping a file that is back in the source | Done | With the lock icon; 6 deletes at once (decision 22) | 4 |
| The run log (⌘L), and the last run under the profile's name | Done | | 4 |

## Links between the modes

| Electron Oriel | State | In Oriel RS | Phase |
|---|---|---|---|
| A folder one mode works on is offered in the others' empty states | Done | In a sandboxed run, Tidy offers only folders inside the sandbox | 7 |
| Open in View from Tidy's Library, Inspector, duplicate tiles, copies, loupe and Overview | Done | Also from the Library's right-click menu | 7 |
| Show in Tidy from the viewer | Done | In a sandboxed run, a folder outside the sandbox gets a toast with the rule | 7 |
| Sync this folder from Tidy's Overview | Done | | 7 |
| Open in View and Tidy this folder from Sync's profile menu | Done | | 7 |
| A file handed to View opens in the viewer once its folder is scanned | Done | View checks only that the path exists, as it has no renderer to grant it to | 3 and 7 |
| The first start's welcome: one folder for View, and for Tidy and Sync if asked | Done | `shell/welcomed` records it; when Electron Oriel's data is found, the welcome offers the import first | 7 |

## Settings

| Electron Oriel | State | In Oriel RS | Phase |
|---|---|---|---|
| General: the theme (System, Light, Dark) | Done | | 2 |
| One Settings page (⌘,), opened at the mode's section from the bottom left of every sidebar; Escape closes it | Done | | 2 |
| General: the data folder | Done | Shown with Show in Finder (Explorer on Windows); `ORIEL_RS_DATA_DIR` moves it; Import… brings Electron Oriel's data | 2 |
| View: remember the last folder, recursive by default, autoplay on hover and in the viewer, loop viewer navigation, sound in previews, loop videos, show images and videos | Done | | 3 |
| View's Diagnostics: index and thumbnail counts, clearing them, ffmpeg's status, worker events | Done | Electron's groups, Copy diagnostics and the two debug switches; no worker crash counts, as there are no workers | 3 |
| Tidy: preferred folders, Convert's options and video quality, background analysis, similar versions, Spot variants, encoders, how long each run takes | Done | Encoders lists 8 (libavif and libvips added, the video encoders being the pinned ffmpeg's); run times are on the Shrink page, as in Electron | 7 |
| Sync: the profiles and where tokens are kept | Done | | 4 |

## Packaging and updates

| Electron Oriel | State | In Oriel RS | Phase |
|---|---|---|---|
| ffmpeg and ffprobe bundled at pinned hashes | Done | `cargo run -p xtask -- bundle` fetches Electron Oriel's pins into the app | after 1 |
| A `.app` with its icon, opened from Finder | Done | 205 MB (Electron Oriel: 503 MB); macOS 15 and later, which Homebrew's aom needs | after 1 |
| Its native libraries inside the app | Done | An LGPL libmpv built from pinned sources, sharp's libvips and Homebrew's libavif, in `Contents/Frameworks` | after 1 |
| About in the app menu: the name and the version | Done | About is a GPUI dialog; it also lists each bundled component's licence | 2 |
| Signed ad hoc, or with `ORIEL_MACOS_SIGN_IDENTITY` | Done | Ad hoc; the owner wants no real identity (decision 19) | after 1 |
| A designed DMG and a ZIP, from `pnpm make:oriel` | Done | Laid out like Electron's (its art, volume icon, 128 px icons, 660 × 400), from `cargo run -p xtask -- dmg`; no ZIP | parity round |
| An offer to move to Applications when started from elsewhere | Done | Copies itself, relaunches, and trashes the old copy unless it is on a read-only volume; paths compared by device and inode | parity round |
| A build workflow that makes the DMG and Setup.exe as artifacts | Left on purpose | GitHub runs only a typecheck (decision 20); `oriel-rs.yml` runs the checks when started by hand | none |

## Windows

Every row here compiles and passes clippy for `x86_64-pc-windows-gnullvm` through llvm-mingw, and a
debug `oriel-rs.exe` cross-links with its icon and version info. None of it has run on Windows, so
every row is Partial until the Windows agent's checks in
[the Windows runbook](../../runbooks/oriel-windows.md) pass.

| Electron Oriel | State | In Oriel RS | Phase |
|---|---|---|---|
| A Windows x64 build | Partial | The MSVC and release builds need a Windows machine (C headers, GPUI's `fxc` shaders) | 8 |
| Setup.exe and an MSI through Velopack | Partial | `cargo run -p xtask -- package` stages the app and runs `vpk pack` for Setup.exe, with Velopack's hooks and no updater; no MSI; never run | 8 |
| The native caption buttons (`titleBarOverlay`) | Partial | GPUI Kit's title bar with its app menu bar, and taskbar progress | 8 |
| A single-instance lock | Partial | A named mutex keyed on the data folder, and a pipe that hands a second launch's paths over | 8 |
| Video playback | Partial | libmpv from shinchiro's GPL build, through its software renderer; the 1080p60 gate is untested | 8 |
| AVIF on screen (Chromium decodes it) | Partial | Through sharp's Windows libvips; Convert encodes with MSYS2's libavif, pinned | 8 |
| Plan 062's fixes: files held open, drives, long paths, names, hard links | Partial | Roots without the verbatim prefix and compared without case, holding at a drive's top, cross-drive moves undone when the original stays open, read-only folders, the Recycle Bin, NTFS change times as Node reads them, `\\?\` paths for libvips | 8 |

## Importing Electron Oriel's data

New in Oriel RS (decision 17), so it is not in the counts above. It reads Electron Oriel's folders
and never writes them, so Electron Oriel keeps working beside it.

| What | State | In Oriel RS |
|---|---|---|
| The welcome offers it first when Electron Oriel's data is found, with counts and sizes | Done | Refused while Electron Oriel runs |
| Settings › General › Import… at any time | Done | What Oriel RS had goes to `before-import-<time>/`, never deleted; the sandbox is never touched |
| The window and preferences, View's settings, index and thumbnails, Tidy's catalog and held files, Sync's profiles, tokens and hash cache | Done | Staged, then put in place at the next start; on a copy of the owner's data every area came over in 1.4 s |
| On Windows | Partial | Electron's Windows folders and `lockfile`; unit-tested on macOS, never run |

## The parity list

Plan 063's parity list is Oriel's 33 e2e cases, each ported to a GPUI Kit headless UI test. A
case counts here as written in its spec, so the loop over four sort orders is one. A test that
needs libvips, the pinned ffmpeg and ffprobe, or a clip they make says so and passes without
checking when they are missing (`cargo run -p xtask -- vendor`, `fetch-media-tools`).

| Case | State | GPUI test | Phase |
|---|---|---|---|
| **[`shell.spec.ts`](../../../e2e/tests/oriel/shell.spec.ts)** | | | |
| Starts in View and switches modes from the switcher and the menu | Done | `starts_in_view_and_switches_modes_from_the_switcher_and_the_menu` | 2 |
| Reopens in the mode it showed last | Done | `reopens_in_the_mode_it_showed_last_with_its_sidebar_and_theme` | 2 |
| Reopens on the page it showed last, with View able to step back up | Done | `reopens_on_the_page_it_showed_last_with_view_able_to_step_back_up` | 2 |
| View keeps its folder while another mode shows | Done | `view_keeps_its_folder_while_another_mode_shows` | 2 |
| One Settings page, at the section of the mode on screen | Done | `one_settings_page_at_the_section_of_the_mode_on_screen` | 2 |
| **[`gallery.spec.ts`](../../../e2e/tests/frame-view/gallery.spec.ts)** | | | |
| Opens a folder, lists its children, and recurses on demand | Done | `opens_a_folder_lists_its_children_and_recurses_on_demand` | 3 |
| Excluding a root child drops its subtree from the recursive scan | Done | `excluding_a_root_child_drops_its_subtree_from_the_recursive_scan` | 3 |
| Filters hide videos and images | Done | `filters_hide_videos_and_images` | 3 |
| A fresh scan lands in the configured sort order | Done | `a_fresh_scan_lands_in_the_configured_sort_order` | 3 |
| A–Z, Z–A, Newest and Oldest match the shared ordering rules | Done | `each_sort_matches_the_shared_ordering_rules` | 3 |
| Random is a permutation and Shuffle changes it | Done | `random_is_a_permutation_and_shuffle_changes_it` | 3 |
| Every image tile renders a thumbnail | Done | `every_image_tile_renders_a_thumbnail` | 3 |
| Double-click opens the viewer, the arrows step, and Escape closes | Done | `double_click_opens_the_viewer_the_arrows_step_and_escape_closes` | 3 |
| A video opens in the capsule player: seek, skip, mute and play or pause | Done | `a_video_opens_in_the_capsule_player_seek_skip_mute_and_play_or_pause` | 3 |
| Comic mode groups leaf folders and the reader opens one | Done | `comic_mode_groups_leaf_folders_and_the_reader_opens_one` | 3 |
| A relaunch restores the remembered folder | Done | `a_relaunch_restores_the_remembered_folder` | 3 |
| **[`e2e/tests/glazier/`](../../../e2e/tests/glazier/)**, nine cases | | | |
| A new folder is scanned and Overview lists what to do with it | Done | `a_new_folder_is_scanned_and_overview_lists_what_to_do_with_it` | 5 and 7 |
| The resized JPEG is grouped with the picture it came from | Done | `the_resized_jpeg_is_grouped_with_the_picture_it_came_from` | 5 and 7 |
| Silent tracks are told apart from sound | Done | `silent_tracks_are_told_apart_from_sound` | 5 and 7 |
| Return keeps the suggested copy and moves on, and Undo brings the set back | Done | `return_keeps_the_suggested_copy_and_moves_on_and_undo_brings_the_set_back` | 6 and 7 |
| Convert turns stills into AVIF and video into MP4, keeping dates | Done | `convert_turns_stills_into_avif_and_video_into_mp4_keeping_dates`; codecs and dates in core-tidy's `the_engine_makes_glazier_cores_changes` | 6 and 7 |
| Clean up fixes the extension, holds the junk and removes the empty folder | Done | `clean_up_fixes_the_extension_holds_the_junk_and_removes_the_empty_folder` | 6 and 7 |
| Shrink re-encodes a busy video to AV1, leaves a compact one, and Undo restores it | Done | `shrink_re_encodes_a_busy_video_to_av1_and_undo_restores_it`; codecs and the compact clip in `the_engine_makes_glazier_cores_changes` | 6 and 7 |
| Tidy up runs every step but duplicates as one change, and one Undo takes it all back | Done | `tidy_up_runs_every_step_but_duplicates_as_one_change_and_one_undo_takes_it_back` | 6 and 7 |
| Spot variants keeps each picture once and moves sets of variants out of review | Done | `spot_variants_moves_sets_of_variants_out_of_review` and `spot_variants_keeps_each_picture_once` | 5 to 7 |
| **[`sync.spec.ts`](../../../e2e/tests/lockstep/sync.spec.ts)**, five cases | | | |
| A profile is created against the running Pane View | Done | `sync_spec_against_a_local_pane_view`, which runs the five cases in order | 4 |
| Plan reports the source as uploads, and push lands them in Pane View | Done | `sync_spec_against_a_local_pane_view` | 4 |
| A second plan has nothing to upload | Done | `sync_spec_against_a_local_pane_view` | 4 |
| Prune deletes the reviewed plan's deletes once, skipping a file back in the source | Done | `sync_spec_against_a_local_pane_view` | 4 |
| The sync token never reaches the settings file in the clear | Done | `sync_spec_against_a_local_pane_view` | 4 |
| **[`e2e/tests/oriel/`](../../../e2e/tests/oriel/)**, the rest | | | |
| A folder Tidy tidies is offered to View, and the modes hand files and folders on (`links.spec.ts`) | Done | `a_folder_tidy_tidies_is_offered_to_view_and_the_modes_hand_files_and_folders_on` | 7 |
| The first start's welcome sets one folder up for View and Tidy (`welcome.spec.ts`) | Done | `the_first_starts_welcome_sets_one_folder_up_for_view_and_tidy_then_shows_no_more` | 7 |
| The first start brings the old apps' preferences and window over (`migration.spec.ts`) | Does not apply | | |

The five Sync cases also run against the local compose stack in
`sync_spec_against_the_local_stack`, which is ignored unless asked for, since it prunes the seeded
e2e library.

## Not ported on purpose

- **The old apps' data.** Electron Oriel's first start brings Frame View's, Glazier's and
  Lockstep's data and tokens over, offers to remove the old apps, and refuses to run Tidy beside
  the old Glazier. Oriel RS imports Electron Oriel's data instead (decision 17), which already holds
  what those apps had, so none of that applies, and neither does File › Import from the Old Apps….
  Nor does Glazier's old holding folder, `<root>/.glazier-holding`, which no Oriel RS catalog ever
  had.
- **Electron's processes.** Tidy's engine host, AVIF pool, transcoder window and IPC go, since the
  engine runs on background threads. View's Diagnostics has no worker crash or restart counts.
- **Mediabunny and WebCodecs.** Convert encodes through ffmpeg instead, so Settings › Encoders
  lists the pinned ffmpeg's video encoders. ffmpeg's hardware encoders are a follow-up.
- **PDFs.** Electron Oriel's View does not read them either (plan 040).
- **Notarization, a real signing identity and auto-update.** Neither app has a notarized release or
  auto-update, and the owner wants none of them (decision 19): the app is for the owner and family,
  who build it themselves.
- **Touch and narrow windows.** Holding the player for 2× by touch (macOS has no touch screen),
  and the settings cog of windows under 640 px, which is below the 960 px minimum. Nor do Home,
  End and the arrows move the scrubber, since GPUI Kit's slider takes no keyboard focus.

## Where Oriel RS differs on purpose

- The theme, the sidebar and the mode are kept under Electron's keys in
  `shell/local-storage.json`, not in Chromium's localStorage.
- While it waits to quit, Oriel RS hides the whole app; any return of the window calls it off.
- GPUI's image cache replaces the in-memory thumbnail layer, so Diagnostics has no memory hits.
- View writes its settings at once, off the main thread, not after a 150 ms debounce.
- View does not enlarge a small still to the thumbnail size asked for, where sharp does.
- View's activity dot also covers thumbnail work; Electron's reports scans only.
- The Library sorts from GPUI Kit's sort icon in each header, not a click anywhere on it.
- Duplicates picks its grid columns by the version count, and the loupe zooms to actual pixels.
- Tidy's walk also pauses between folders, and Check now also hurries an analysis already running.
- Sync's Cancel stops uploads in flight, as lockstep-core does, though Electron's panel says they
  finish first.
- Sync's `/` focuses the plan filter from a key handler, so a text field keeps its `/`.
- The welcome is "Welcome to Oriel RS", and the three mode icons stand in for the animated mark.
  When Electron Oriel's data is found it offers the import first; Electron's welcome has a line
  about the old apps' data instead.
- Tidy's "Tidy “name”?" question is a GPUI Kit alert dialog, not a native sheet.
- About lists the licences of every bundled part, read from `Contents/Resources/licenses/`.
- Duplicates was cleaned up at the owner's request (2026-10-31): a line saying why a version is
  kept; a scope list (Similar, Variants, Identical) instead of tabs and a top-bar toggle; one "Matching"
  popover for the similarity level and Spot variants; fact lanes that line tiles up; a fate line
  per tile ("Keep", "Suggested", "Goes to holding"); one `…` menu and a right-click menu with
  Prefer this folder. N reads "Keep both" or "Keep all" everywhere, and Spot variants' note reads
  "Same picture as 1".
- Overview's cards both read "frees up to …", and its hero says "not counting duplicates".
  Convert's tiles fill the row, and "N wait for duplicate review" is a button. Errors say what
  failed ("Couldn't …") and offer Try again.
- Sync hashes 16 files at once (Electron: 4), adapts its upload width between 3 and 6 (Electron:
  always 3), and prunes 6 at once (Electron: 1), as decision 22 asks.
- Empty Holding marks a batch emptied when its folder is already gone, where Electron's Trash call
  fails and leaves it held, so an imported batch whose files never arrived can be cleared.
- Off macOS, Quick Look reads "Open in Default App", and the Library's menu shows only Open.
- After the owner's first install (2026-10-31): one activity panel at the window's bottom right
  shows every mode's running and queued work, with Pause and Stop, in place of Tidy's job card, the
  pages' in-place progress, Sync's running panel and View's scanning pill. Tidy's changes queue
  behind one another instead of being refused.
- Every mode's sidebar is headed by one location switcher, Tidy's, whose dropdown offers every
  folder any mode uses, marked with the modes that use it. Sync's profiles live in it.
- Duplicates has no Not duplicates list and no "goes to holding" summary; its buttons are larger
  and centred.
- Video sound goes to the output as float stereo, as macOS's CoreAudio refused FFmpeg's planar
  AAC; surround sound is downmixed.
- Duplicates' video versions play in their tiles, muted and looping; a click on the picture plays or
  pauses it, and the rest of the tile keeps the version. Electron's grid showed poster frames.
- Every control follows one size scale (`oriel_ui::controls`): the theme's 13 px base is GPUI Kit's
  rem, which sized its controls for 16 px, so they are set one size up and never below 26 px.
