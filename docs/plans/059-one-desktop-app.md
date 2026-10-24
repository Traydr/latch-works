# Plan 059: Oriel, one desktop app with three modes, and an installer worth opening

> **Executor instructions**: Revised 2026-10-24 with the owner's answers. The owner's brief: fold
> Frame View, Glazier and Lockstep into one app with three modes, in Glazier's house style (Frame
> View's where the viewer is concerned), replacing the three apps and carrying their data over,
> with a customised installer for macOS and Windows. The settled decisions below must not be
> re-asked. The owner asked for one PR, on `agent/059-oriel`, for every phase; commit per step, and
> update the plan index as phases land. A rendered copy with the shell mockup is published at
> <https://vellum.traydr.dev/3L9QtFB8SkCLTBdrcFG7PawwlJO> (30-day link, until 2026-11-23); this
> file is the record.
>
> **Drift check (run first)**: `git diff --stat 0d3af1d..HEAD -- apps/frame-view apps/glazier
> apps/lockstep packages/app-data e2e/src`. If any app grew a new process, IPC channel, protocol
> or data file, add it to the inventory under "What moves where" before moving code.

## Status

- **Status**: IN REVIEW (Phases 1–10 on `agent/059-oriel`, 2026-10-24)
- **Priority**: P2 (the owner asked for it)
- **Effort**: XL overall, as ten stacked PRs of S–L each
- **Risk**: MEDIUM to HIGH. It touches every desktop app's process model. The data migration
  handles saved sync tokens, and Glazier's undo depends on its data folder never moving.
- **Depends on**: 058 (Glazier) and 057 (Frame View parity) landing first, so the code being moved
  is final
- **Planned at**: commit `0d3af1d`, 2026-10-24

## Why one app

The three desktop apps are stages of one workflow (Gather → **Organize → Sync → View**). They
are already closer than they look:

- **Data.** They share one data folder, `~/.latch-works/<app>` (`@latch-works/app-data`).
- **Stack.** They run Electron 44.7.2, Forge 8, Vite 8, React 19, Tailwind 4 and zod, with the
  same fuses and the same signing code.
- **Native runtime.** Frame View and Glazier each stage the same ffmpeg, ffprobe and sharp.
  Today that costs 370 MB + 374 MB + 289 MB on disk (the `.app` bundles in `out/`) and three
  builds. One app would be about 400 MB, because the Electron runtime and the native runtime
  ship once.
- **IPC.** Glazier's and Lockstep's channels are already namespaced (`glazier:*`,
  `lockstep:*`) and their preload globals don't collide (`glazier`, `lockstep`, Frame View's
  own). Only Frame View's channels (`settings:get`, `scan:start`, `app:command`, …) need a
  prefix.

What the owner gets from merging: one icon in the Dock, one build, one theme and settings page,
and links between the stages. For example, open a Glazier duplicate in the viewer, view a folder
Glazier just tidied, or sync it from where you are.

## Settled decisions (2026-10-24, do not re-ask)

1. **Mode names: View · Tidy · Sync** (D2), with the old app icons as their glyphs. The old names
   stay in history and in the CLI (`lockstep`).
2. **Closing the window quits** (D3), unless a sync push or a Glazier change is running. Then the
   window hides, the Dock icon shows progress, and the app quits when the work ends.
3. **Modes keep their state** when you switch away (D4). Hidden modes stay mounted and keep
   running, hidden and inert (Phase 4 explains why not `<Activity>`).
4. **The app replaces the old apps and migrates as much of their data as it can** (D5). That
   covers catalogs and settings (already in place), saved sync tokens, renderer preferences,
   window size and the folder lists. Then it offers, with one confirmation, to remove the old
   apps. Phase 5 has the details.
5. **No code signing for now; people build from source** (D6). The audience is very small and
   builds from the repository. macOS builds stay ad-hoc signed, and nothing is notarized or
   published. Signing is a follow-up, and the plan keeps it to environment variables when it
   comes.
6. **Velopack is the Windows installer** (D7), replacing Squirrel. Its first step proves it works
   with Forge's output; Squirrel with a branded `loadingGif` is the fallback only if a STOP fires.
7. **Agents may run `package` and `make`** for Oriel (D8), on the owner's machine. This
   lifts the rule in Frame View's `AGENTS.md` for `apps/oriel`.
8. **Layout A**, the mode switcher in the sidebar header (see the mockup), is roughly right.
   Phase 7 builds it and trials only its details.
9. **The app is called Oriel** (D1): a bay window that juts out, so you see more. It sits in the
   family's window-and-glass language beside Frame View, Pane View, Glazier and Latch.
10. **Sync tokens live in `~/.latch-works` on both platforms**, not the Keychain or DPAPI. Sync
    uses Lockstep's existing `FileSecretStorage` everywhere: AES-256-GCM under a random key in
    `~/.latch-works/lockstep/secret-storage.key` (mode 0600). An unsigned build's signature
    changes with every rebuild, which made the Keychain ask again each time. The trade-off is
    that the key is protected by the home folder's permissions alone.

Smaller choices settled by default (change by saying so):

- **Architecture.** macOS arm64 and Windows x64 only.
- **Shortcuts.** ⌘1–3 switch modes. Tidy's pages move from ⌘1–7 to ⌥⌘1–7 (Ctrl+Alt on Windows).
- **Code style.** The merged app uses the root Biome style (double quotes). Frame View's code is
  reformatted once, in a commit of its own, when it moves.
- **Names and paths.**
  - The workspace is `apps/oriel` and the package `@latch-works/oriel`.
  - The bundle id is `dev.traydr.latchworks.oriel` and the executable `oriel`.
  - The shell's data folder is `~/.latch-works/oriel`.
  - The environment variables are `ORIEL_MACOS_SIGN_IDENTITY` and `ORIEL_DISABLE_GPU`.

## How the name was chosen

The owner wanted a new name rather than "Latch Works" and chose **Oriel** from this shortlist, in
the family's window-and-glass language: Casement, Oriel, Sash, Mullion, Leadlight, Glasshouse,
Lightbox, Framewright, Porthole, Vitrine (a 2026 Mac wallpaper app has it) and Curio (Zengobi's
Mac app has it). A search found only a 1991 Windows scripting language called Oriel.

## Target shape

```text
apps/oriel/                          productName "Oriel"
  forge.config.ts                    the union of the three configs, native runtime staged once
  src/main.ts                        composition root: Velopack hook, single-instance lock, data
                                     folders, both media schemes, menu, window, mode lifecycle
  src/preload.ts                     window.oriel for the shell; each mode keeps its standalone
                                     app's global (window.lockstep, window.glazier, …)
  src/shell/                         window chrome, mode switcher, sidebar and rail, settings page,
                                     theme, toasts, folder picker, first-run welcome, migration
  src/ui/                            the house kit: Glazier's gz-* tokens and ui.tsx, renamed lw-*
  src/modes/view/{main,renderer,shared}    from apps/frame-view (catalog and thumbnail workers)
  src/modes/tidy/{main,renderer,shared,    from apps/glazier
                  engine,transcoder}
  src/modes/sync/{main,renderer,shared}    from apps/lockstep
  installer/                         DMG background (1x, 2x), Velopack splash GIF, MSI bitmaps,
                                     volume icon
```

**Mode contract.** Each mode's main side exports `start<Mode>(ctx)` with
`ctx = { dataDir, window: () => BrowserWindow | null, send(channel, payload) }`. It returns
`{ menu(): MenuItemConstructorOptions[]; busy(): boolean; dispose(): Promise<void> }`:
- `menu()` is the mode's File and View items, which the shell swaps in when the mode becomes
  active.
- `busy()` feeds settled decision 2.

Each mode's renderer exports one root component. It is mounted under a `ModeFrame`, which hides
it, makes it inert and pauses its media while another mode shows, and provides
`useModeActive()`.

**Process start.** A mode's heavy processes start the first time that mode opens, not at launch.
That means Frame View's catalog and thumbnail utility processes, and Glazier's engine, AVIF pool
and hidden transcoder window. Lockstep's services are cheap and start at launch, since a run must
outlive the window.

**Data folders do not move.** The shell's own Electron `userData` is `~/.latch-works/oriel`
(window state, Chromium caches, the shared `localStorage`). Each mode keeps
`~/.latch-works/frame-view`, `glazier` and `lockstep` exactly as today. `app-data` gains
`latchWorksModeFolder(app, name)`, which nests under `--user-data-dir` when one is passed, so each
e2e run stays isolated. If an old app never ran after the move to `~/.latch-works`, its data is
still in `~/Library/Application Support/<App>` (or `%APPDATA%\<App>`). In that case
`latchWorksModeFolder` moves it into place exactly as `setLatchWorksDataFolder` does today.

## What moves where (inventory at `0d3af1d`)

| Concern | Frame View | Glazier | Lockstep | Merged |
|---|---|---|---|---|
| Media scheme | `frameview-media` | `glazier-media` | — | Both, registered in **one** `registerSchemesAsPrivileged` call before ready |
| Utility processes | catalog worker, thumbnail broker | engine, AVIF pool | — | All, started lazily per mode |
| Extra windows | — | hidden transcoder (own preload and renderer) | — | Kept: two renderer entries, two preloads |
| GPU | on; `FRAME_VIEW_DISABLE_GPU` turns it off | on (WebCodecs encoders need it) | off (a cloud-VM workaround, `52de5ae`) | **On**; `ORIEL_DISABLE_GPU=1` for VMs |
| Single instance | yes, with `open-file` and argv paths | no | no | Yes; OS-handed paths open in **View** |
| Secrets | — | — | `safeStorage` (Keychain or DPAPI) | A key file in `~/.latch-works/lockstep` on both platforms; old tokens migrated (Phase 5) |
| Native runtime | ffmpeg, ffprobe, sharp | the same, plus libavif wasm | — | Staged once, plus Velopack's module on Windows |
| Theme | settings file | `localStorage` | follows the system | One app setting: System, Light or Dark |
| Window chrome | native | hidden inset on macOS | native | Hidden inset on macOS, `titleBarOverlay` on Windows |
| Windows installer | Squirrel | Squirrel | Squirrel | Velopack |

## Phases

Order rationale: move the code first, unchanged in look, so the restyle happens once in one
codebase with one token set. The migration comes once all three modes run in the new app. The
payoff features follow, and the installer comes last because it needs the final name and icon.

### Phase 1: scaffold the shell (M)

1. Create `apps/oriel` with the merged Forge config:
   - the union of the Vite entries (main, two workers, engine, AVIF worker, two preloads, two
     renderers);
   - the native runtime staged once;
   - the same fuses;
   - `osxSign` with `ORIEL_MACOS_SIGN_IDENTITY`, ad-hoc when it is unset;
   - DMG and ZIP makers on macOS, and no Squirrel maker (Velopack arrives in Phase 10).
2. Build `src/main.ts`: the single-instance lock, `setLatchWorksDataFolder(app, { folder:
   "oriel" })` plus `latchWorksModeFolder`, both schemes, an app menu with ⌘1–3 for the modes,
   and one window (hidden inset on macOS).
3. Build the shell renderer with a placeholder per mode and Layout A's switcher. Copy Glazier's
   `index.css` tokens into `src/ui/` unchanged for now.
4. Add `e2e/src/oriel.ts` (launch, `openMode`) and a shell spec: it starts, ⌘1–3 switch, and the
   window title follows the mode.

### Phase 2: move Lockstep in as Sync (S)

Done. Each move phase also deletes the rest of its standalone app, since a
workspace left with a manifest and no source breaks `pnpm -r build`. Lockstep's showcase preview
went with it; Showcase screenshots come from Oriel in Phase 10. Sync's legacy CSS is scoped under
`.mode-sync`, so its `prism-*` classes never meet Frame View's of the same names.

The smallest mode, with namespaced IPC. `git mv` its `main/`, `renderer/`, `shared/` and preload
API into `src/modes/sync/`. Wrap `ProfileService` and `RunService` in `startSync(ctx)`. Retarget
`e2e/tests/lockstep` at the Oriel launcher. Sync uses `FileSecretStorage` packaged or not (settled
decision 10), so `LOCKSTEP_SECRET_STORAGE` goes. Until Phase 5 migrates them, tokens the old
packaged Lockstep saved don't decrypt in Sync, and their profiles ask for the token.

### Phase 3: move Glazier in as Tidy (M)

Done. Tidy's IPC and media protocol register at launch, because its window
can call them as soon as it mounts. The engine process starts with its first call, and the hidden
transcoder window when the window first shows Tidy (`ModeHost.activate`). The shell now quits when
its window closes, not when every window has, since the transcoder window outlives it. Tidy's
renderer errors stay inside the mode, so the switcher keeps working.

`git mv` the engine host, AVIF pool, transcoder window and its preload, the media protocol, IPC,
and the renderer. Its menu becomes `menu()`, with view shortcuts on ⌥⌘1–7. Give the transcoder
renderer its own Vite `cacheDir`, as 058 item 8 found necessary. Retarget `e2e/tests/glazier`.

### Phase 4: move Frame View in as View (L)

Done, as a rename-only commit, a formatting commit, and the wiring.

- **Hidden modes stay live.** `<Activity>` turned out wrong for these apps (decision 3 is kept;
  only the mechanism changed). Activity tears down a hidden mode's effects. That would have
  cancelled View's scan and dropped its scan events on every switch away, and rescanned on every
  return; Sync and Tidy would have missed run and job events in the same way. Every opened mode
  now stays mounted, hidden and inert, with its effects running.
  - Window-level keys and drops attach only while `useModeActive()` is true.
  - The viewer and the comic reader are modal only then.
  - The shell pauses a hidden mode's media.
- **The shell remembers the window** in `~/.latch-works/oriel/window-state.json`. Frame View's own
  window persistence went; Phase 5 seeds the shell's file from it.
- **Icon.** Oriel uses Frame View's artwork as its icon until Phase 10.
- **Dropped.** Frame View's showcase preview, and `drizzle-kit`, which had no migrations in the
  repository: the media index creates its tables itself.
- **Lint.** Frame View's two lint exceptions (`useExhaustiveDependencies` and `useMediaCaption`)
  carry over as a Biome override for `src/modes/view`.

1. Prefix its channels with `frame:` and route launch, `open-file` and second-instance paths to
   View.
2. Change the renderer's `h-screen` roots to `h-full` and gate its window key handlers on
   `useModeActive()`.
3. Reformat to the root style in a separate commit.
4. Retarget `e2e/tests/frame-view` and `e2e/scripts/frame-performance.ts`.

### Phase 5: migrate the old apps' data and replace them (M)

Done. It runs once, on first start, before the window opens. File ›
Import from the Old Apps… runs it again. It records what it did in `~/.latch-works/oriel/migration.json`. A re-run
never overwrites a value the new app has since changed.

1. **The old apps must not be running.** If Frame View, Glazier or Lockstep is open, the app says
   so and waits for them to quit. On macOS, find them by bundle id
   (`dev.traydr.latchworks.{frameview,glazier,lockstep}`); on Windows, by their executables. Tidy
   also refuses to open the catalog while the old Glazier runs, because two engines on one catalog
   is the one thing here that can lose work.
2. **Catalogs, caches, settings and holding.** Nothing to copy: they are already in
   `~/.latch-works/<mode>`. Check that each folder is there (moving a legacy folder into place, as
   above), and report it.
3. **Sync tokens.** Each profile's `encryptedToken` is Chromium OSCrypt ciphertext made with the
   old Lockstep's key (a token that already decrypts with `FileSecretStorage`, from a development
   run, is left alone). Decrypt it with the old key and save it again through `FileSecretStorage`:
   - **macOS.** The key is the Keychain item `Lockstep Safe Storage`. Read it with
     `security find-generic-password -w -s "Lockstep Safe Storage"`; macOS asks the owner once.
     The `v10` blob is AES-128-CBC with a key from PBKDF2-HMAC-SHA1 (salt `saltysalt`, 1003
     rounds, 16 bytes) and an IV of 16 spaces.
   - **Windows.** The key is `os_crypt.encrypted_key` in `~/.latch-works/lockstep/Local State`
     (the old userData moved there whole). It is DPAPI-protected, so unprotect it as the current
     user through PowerShell's `ProtectedData.Unprotect`. The `v10` blob is AES-256-GCM: a 12-byte
     nonce, then ciphertext and tag.
   - **Check before saving.** A migrated token is kept only when it decrypts and is printable
     ASCII. GCM authenticates on Windows; on macOS a wrong key fails CBC's padding, or leaves bytes
     that are not a token. This replaced the planned doctor check against the profile's server, so
     the first start never depends on the network. Any failure leaves the blob as it was, and that
     profile shows its "enter your token" state.
   - **Handle the secrets carefully.** Never log a token or key. Pass them through stdout, never
     argv, and keep them in memory only for the migration.
4. **Renderer preferences.** These are Glazier's theme, sidebar rail, convert options and Library
   view, and Frame View's video volume.
   - Copy each mode folder's `Local Storage` into a temporary folder.
   - Open the copy with `session.fromPath()` in a hidden window on a `file://` page, which is the
     origin the packaged apps used, and read the keys.
   - Write them under the new app's mode-prefixed keys.
   - The theme becomes the app setting: Glazier's if it had one, else Frame View's, else System.
5. **Window and folders.**
   - Seed the window size and position from Frame View's saved window state.
   - Collect Frame View's remembered root, Glazier's roots and Lockstep's source roots into the
     shell's folder list, for Phase 9.
6. **Replace the old apps**, after one confirmation that lists them.
   - **macOS.** Move each old `.app` from `/Applications` or `~/Applications` to the Trash with
     `shell.trashItem`. Never touch a bundle elsewhere, such as the repository's `out/` folders.
   - **Windows.** Run each old Squirrel install's `Update.exe --uninstall` (`%LocalAppData%\frame-view`,
     `glazier`, `lockstep`). That also removes their Start-menu shortcuts.
7. **Report.** One line in the welcome says what came along. A second line appears only if
   something didn't, such as a token to enter again.

### Phase 6: retire the standalone apps (S)

Done.
- **Tags.** The three tags are local until pushed.
- **e2e names.** The e2e projects keep their names (`frame-view`, `glazier`, `lockstep`), which
  already run against Oriel's modes, rather than becoming `oriel-*`.
- **Left for Phase 10.** Showcase's `capture-frame-view.mjs` and `capture-lockstep.mjs` still
  drive the retired apps. They already pointed at Frame View's pre-`~/.latch-works` folders, and
  Phase 10 retakes the screenshots from Oriel.

1. Tag the last standalone builds (`frame-view-v1.1.0`, `glazier-v0.2.0`, `lockstep-v0.3.0`, all at
   `0d3af1d`), so a hotfix can branch from them.
2. Check nothing of the three apps is left: Phases 2–4 delete each one's Forge config, manifest
   and leftovers as they move it.
3. Merge the e2e projects into `oriel-view`, `oriel-tidy` and `oriel-sync`, and keep
   `e2e:frame`, `e2e:glazier` and `e2e:lockstep` as aliases.
4. Update `ARCHITECTURE.md`, the brand kit's name system, the runbooks, `docs/design/icons.md`,
   `docs/electron-macos-signing.md` and Knip. In Frame View's rules, record that agents may now run
   `make` for Oriel.

### Phase 7: the shell in house style, Layout A (M, `design-trials` on the details)

Done, without trials: the defaults below were built and the owner can ask for a trial of any.
- **Switcher in rail form.** Stacked icons, as Layout A drew it.
- **View's sidebar.** The rail, so the gallery keeps the width; a folder tree is not built.
- **Activity.** Each mode's renderer reports its own work to the switcher (`useReportActivity`):
  a ring for a Sync push or prune and a Tidy apply or undo, a dot for a View scan or a Tidy scan
  or analysis.
- **Settings.** General holds the theme, the data folder and the import. View's four tabs became
  house groups in one column, and Frame View's numbers sit behind Diagnostics › Show. Sync lists
  the profiles, each opening Sync's own profile form.
- **The house kit** (Glazier's `ui.tsx`) moved to `src/ui/` now, since View and the shell use it.
- **Left open.** Windows chrome (`titleBarOverlay`, Mica) waits for a Windows machine to try it on.

Build Layout A: a View · Tidy · Sync segmented control under the traffic lights, and the active
mode's navigation below it.
- In rail form, the three mode icons stack above the mode's icons.
- Work running in another mode shows on its switcher item: a ring while a push runs, a dot while
  Tidy analyses.
- Glazier's rail sizes stay: 88 px on macOS, 56 px elsewhere.

Trial only what Layout A leaves open:

- **View's sidebar.** A folder tree, or the rail by default so the gallery gets the width. In
  both, the viewer covers the whole window, sidebar included.
- **The switcher in rail form.** Stacked icons, or a single mode button that opens a menu.
- **Windows chrome.** `titleBarOverlay` with the native caption buttons, with or without Mica
  (`backgroundMaterial`).

Then **one Settings page** (⌘,), with a section per mode in Glazier's settings layout. It replaces
Frame View's settings drawer and Lockstep's settings, and holds the single theme setting.

### Phase 8: Sync and View restyled (L, `design-trials` for Sync)

Done, without a Sync trial: the layout below was built as written, and the owner can ask for a
trial of any part. Rename `gz-*` to `lw-*` in one mechanical commit before either (done).
- **Sync.** The profiles' menu (Edit, Check connection, Run log, Delete) moved to the page's top
  bar, so the rail form keeps it. Lockstep's status bar went; the last run shows under the
  profile's name and in the top bar. The run log floats along the bottom.
- **View.** Its 16 px base font went with the Prism classes, so it reads at the house 13 px. The
  "1 items" badge keeps Pane View's wording, which the e2e pins.

- **Sync** is rebuilt in house style, which was already a 058 follow-up:
  - profiles in the sidebar, as Glazier lists folders;
  - the plan tree as the page;
  - the run as a floating panel (`lw-float`).
  - Drop Geist and the mono, 10 px, upper-case `ls-label` (both break the house rules), which
    also removes the broken Geist `@import` that 058 noted.
- **View** keeps its behaviour and 057's settled toolbar decisions (order, visible labels,
  button names the e2e selects). Its `prism-*` classes become house tokens:
  - toolbar buttons become `lw-btn`;
  - the bottom bar becomes `lw-float`;
  - the folder overlay becomes `lw-card` tiles.

  The viewer's dark scrims and overlay buttons stay, because the media comes first there.

### Phase 9: links between the modes (M)

Done.
- **Hand-offs.** One mode hands another a file or folder through the shell, in the window. View's
  goes through the main process, which opens the path only inside a folder some mode already
  works on (symlinks resolved), so View still scans only folders the owner chose.
- **Where the links are.** Open in View sits in the Library's menu and Inspector, on duplicate
  tiles, copies and the loupe, and on the Overview; Show in Tidy in the viewer's top bar; Tidy
  this folder and Sync this folder in a menu on View's header; Open in View and Tidy this folder
  in Sync's profile menu.
- **A file opens in the viewer.** View opens a handed file, or one the OS opens with Oriel, in the
  viewer once a scan of its folder that started after the hand-off has finished.
- **The folder list** is read fresh from each mode's own storage, never copied: View's last
  folder, Tidy's catalog, Sync's profiles and `migration.json`. A mode's empty state offers the
  folders it does not have, skipping any no longer on disk.

- **Open in View** from any Tidy tile, duplicate or Library row (opens the viewer at that file),
  and **Show in Tidy** from View.
- **Tidy this folder** from View's folder menu (adds the root to Glazier).
- **Sync this folder** from Tidy's Overview. It picks the Lockstep profile whose source root
  contains the folder, or starts a new profile with the folder filled in.
- A folder added in any mode is offered to the others the first time they open. The list starts
  from Phase 5's migrated folders. Each mode keeps its own storage; the shell only proposes.

### Phase 10: installer, first run and building from source (L)

Built; the Windows half is proven only by the [Oriel build](../../.github/workflows/oriel-build.yml)
workflow, since no Windows machine was at hand.
- **Icon.** A bay window onto the view, in the family's plate and palette. The Icon Composer
  bundle is `media/oriel.icon` (not `oriel-icon.icon`, which packager would compile on every
  Mac): Forge passes it only where `actool` 26 runs, on macOS 26 and later.
- **Installer art** comes from SVG masters in `apps/oriel/installer` through `pnpm icons`: the DMG
  background at 1x and 2x, the MSI's BMPs (written by the script, which sharp cannot), and
  Setup's splash, drawn frame by frame in the script.
- **Velopack** is staged on Windows only, beside sharp, and loaded from the resources first thing
  in `main.ts`. Forge keeps a Windows ZIP maker, since `postMake` runs only after a maker.
- **First run.** The welcome is skipped under `--user-data-dir`; `ORIEL_WELCOME=1` brings it
  back for the e2e suite, which answers the native folder dialog from the main process. The folder
  the dialog returns stays in the main process, so the window cannot set up any other.
- **Showcase.** `capture-oriel.mjs` replaces the two old capture scripts. It runs Oriel on a
  throwaway data folder rather than backing up the owner's settings, and takes Sync's server from
  `SHOWCASE_PANE_VIEW_URL` and `SHOWCASE_SYNC_TOKEN` when set. The site's pages still describe
  Frame View and Lockstep; telling Oriel's story there is a follow-up.

**macOS**
1. **Icon.** A new app icon master `apps/oriel/media/oriel-icon.svg`, plus an Icon Composer
   `.icon` bundle with light, dark and tinted variants for macOS 26 and later (Lockstep already
   ships one), with `.icns` as the fallback. Add it to `pnpm icons`.
2. **DMG.** A designed DMG through `MakerDMG`:
   - background at 1x and 2x (`background@2x.png`, which appdmg picks up);
   - a 660 × 400 window via `additionalDMGOptions.window`;
   - a 128 px icon and the Applications alias placed through `contents`, with an arrow between
     them in the artwork;
   - the volume icon and the name "Oriel";
   - `ULFO` format.

   Finder draws icon labels white in Dark Mode and black in Light, so the artwork must keep both
   readable: put a mid-tone plate behind the labels.
3. **First launch.** If the app runs outside `/Applications`, offer
   `app.moveToApplicationsFolder()`.

**Windows (Velopack)**
1. **Prove it first** (half a day; it gates the rest).
   - Add the `velopack` package and call `VelopackApp.build().run()` first thing in `main.ts`, in
     place of `electron-squirrel-startup`.
   - Velopack ships a native module, and its docs warn it may not survive Vite. Mark it external
     in `vite.main.config.mts` and stage it through `extraResource`, as sharp is today.
   - Run `vpk pack` over Forge's packaged `out/Oriel-win32-x64`. STOP and fall back to Squirrel
     with a branded `loadingGif` if the installed app loses its fuses, ASAR integrity checks or
     `safeStorage`.
2. **Setup.exe.** Pass `--packTitle`, `--icon`, `--mainExe`, and `--splashImage
   installer/splash.gif`, the animated brand splash shown while it installs. Start-menu and
   desktop shortcuts come by default.
3. **MSI, for those who want a wizard.** Add `--msi` with `--instLocation Either` (per user or for
   the machine), welcome and conclusion pages, and the branded `--msiTopBanner` (493 × 58) and
   `--msiDialogBackground` (493 × 312) bitmaps.
4. **One command.** A Forge `postMake` hook runs `vpk pack` on Windows, so
   `pnpm --filter @latch-works/oriel make` gives Setup.exe and the MSI. It needs the .NET SDK
   and a pinned `vpk` (`dotnet tool install -g vpk --version <pin>`).
5. **Build it on Windows.** Forge stages the host's native binaries (sharp, ffmpeg-static), so a
   Windows package made on a Mac would carry Mac binaries. `vpk` can cross-pack, but its input
   cannot be cross-built.

**First run, both platforms.** The "cool" carries on inside the app, in house style. It is one
short, skippable welcome:
1. The mode glyphs assemble into the app mark.
2. Phase 5's one-line report, when there was anything to migrate.
3. "Choose your archive folder", if no folder came over: one folder, offered to all three modes.
4. Optionally, connect Pane View, if no Sync profile came over (a server address and token).
5. Land in View, already scanning.

**Showcase screenshots.** Rewrite `apps/showcase/scripts/capture-frame-view.mjs` and
`capture-lockstep.mjs` (and add Tidy) to drive Oriel, switching modes from the switcher, and
retake the screenshots after Phases 7–8.

**Building from source.**
- Write `docs/runbooks/oriel.md`:
  - the prerequisites for each OS: Node 24 and pnpm 12, Xcode's command-line tools on macOS, and
    the .NET SDK and `vpk` on Windows;
  - one command, `pnpm make:oriel`, and where its output lands;
  - for a DMG carried to another Mac, how to clear quarantine (`xattr -dr
    com.apple.quarantine`, or Privacy & Security → Open Anyway), since nothing is notarized.
- Add `.github/workflows/oriel-build.yml`. It runs on demand and on PRs touching `apps/oriel`.
  It builds the unsigned DMG on `macos-latest` and Setup.exe on `windows-latest` as workflow
  artifacts. On Windows it also installs silently and checks that the app starts. It publishes no
  release, and `check.yml` is unchanged.

## Risks and STOP conditions

- **Glazier's data folder must never move.** Holding lives in it, and the catalog records each
  held file's full path (migration 3), so a moved folder breaks every undo. STOP if any step would
  change `~/.latch-works/glazier`.
- **Tokens in a file.** Anyone who can read the home folder can read the tokens. The key file
  stays 0600 and is never logged, copied into the archive or
  synced.
- **Token migration.** The owner's three saved tokens are `v10` blobs, and the Keychain item is
  `Lockstep Safe Storage` (account `Lockstep Key`), both checked on their Mac on 2026-10-24.
  Windows is untested. A blob that is not `v10`, or does not decrypt to a printable token, is
  left as it was, so its profile asks for the token again; a garbled token is never saved.
- **Hidden modes stay live** (Phase 4). A hidden mode keeps its subscriptions, so its state stays
  right. The cost is that every listener it puts on the whole window (keys, drops) must attach
  only while `useModeActive()` is true. A new one that does not will act in another mode; check
  for `window.addEventListener` in review. A modal dialog must likewise be modal only while its
  mode shows, or it makes every other mode inert.
- **Hardware encoders.** STOP if Tidy's transcoder reports no hardware encoders in the merged app
  while standalone Glazier did. The GPU must stay on.
- **Removing the old apps.** Only bundles in `/Applications` and `~/Applications`, or the old
  Squirrel installs, are ever removed, and only after the migration report says their data came
  along.
- **Two catalogs scan the same folder.** View's media index and Tidy's catalog stay separate in
  this plan (see Follow-ups). Both scanning one root at once must stay correct, only slower.
- **Codesign.** Staged runtime packages, Velopack's included, must stay real files, not pnpm
  symlinks (`docs/electron-macos-signing.md`). Check with `codesign --verify --deep --strict` on
  every macOS `make`.

## Verification

Per phase:

```sh
pnpm --filter @latch-works/oriel typecheck && pnpm --filter @latch-works/oriel test
pnpm test && pnpm typecheck && pnpm lint:all && pnpm knip
pnpm e2e:frame && pnpm e2e:glazier && pnpm e2e:lockstep   # retargeted at Oriel
```

Before calling Phase 6 done, run all three suites against one Oriel build, plus the shell spec:
mode switching keeps state, ⌘1–3 work, and a path handed over by the OS opens in View.

Phase 5 is checked on a copy of the owner's real `~/.latch-works` and on a fixture made by
running the three old apps once. Check that:
- each token passes the doctor;
- Glazier's preferences and theme arrive;
- the folder list holds every root;
- a second run changes nothing.

Phase 10 adds these checks:
- `codesign --verify --deep --strict` on the `.app`.
- Mount the DMG in both Light and Dark Mode and screenshot it.
- Install Setup.exe and the MSI on Windows, and screenshot the splash and the Start-menu entry.
- First run with an empty `~/.latch-works`, and again with the old apps' data in place.

## Follow-ups (not in this plan)

- **Signing and publishing** (D6 deferred).
  - On macOS: Developer ID, notarization through Forge's `osxNotarize`, and stapling.
  - On Windows: signing through `vpk`.
  - Then a release workflow and auto-update (Velopack's on Windows; Squirrel.Mac needs a signed
    app).
- **One catalog.** View's media index and Tidy's catalog index the same roots with the same
  sniffing and hashing; one could serve both. Lockstep's hash cache could share Glazier's hashes
  too.
- **Old Chromium caches.** The mode folders still hold the old apps' `Cache`, `Code Cache` and
  `GPUCache`. They could be removed, but only from an allowlist, once the migration has run.
- **A Home across the stages.** Folders, tidy state, last sync, recent views. Only if the modes
  alone turn out not to be enough, since the owner's brief is against extra screens.
- The `glazier` CLI from 058 stays a follow-up; the Lockstep CLI is unaffected.
