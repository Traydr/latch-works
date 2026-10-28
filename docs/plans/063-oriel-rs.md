# Plan 063: Oriel RS, Oriel ported to Rust on GPUI, as an experiment

> **Executor instructions**: Written 2026-10-27 at commit `4c76020b`, revised the same day with
> the owner's answers. The brief:
> - a full port of Oriel to Rust on GPUI, using a GPUI component kit, with no Node process;
> - its own data, for now;
> - beside the Electron Oriel, not replacing it.
>
> Electron Oriel stays the app the owner uses. This plan ends with a scorecard on which the owner
> decides whether to go further. Phase 0 is a gate: stop after it and report. D1 (which GPUI line)
> is settled: A, GPUI Kit on Zed's GPUI (the owner, 2026-10-28). Read plan 059 and
> `docs/runbooks/oriel.md` first. A rendered copy is published at
> <https://vellum.traydr.dev/3LI5Hp4XWgK0CCyoqiovPSMdrt6> (30-day link, until 2026-11-26); this
> file is the record.
>
> **Drift check (run first)**: `git diff --stat 4c76020b..HEAD -- apps/oriel/src
> packages/glazier-core/src packages/lockstep-core/src packages/media-domain/src
> packages/media-format/src packages/media-index/src e2e/tests`. A behaviour change there
> changes a conformance vector (see "Keeping two implementations honest"), so port it or put it
> on the catch-up list.

## Status

- **Status**: IN PROGRESS. Phase 0 is done (2026-10-28, branch `agent/063-0-spike`); its report
  is [docs/research/oriel-rs-phase0.md](../research/oriel-rs-phase0.md). Every STOP condition
  passed, and the owner accepted the two differences and chose go (decisions 3 to 6 above).
  Phase 1 is done too (2026-10-28, branch `agent/063-1-foundations`; see "Phase 1 results").
  Phase 2 is next, after the two questions under Phase 1 results.
- **Priority**: P3 (an experiment the owner asked for)
- **Effort**: XL several times over. About 24.8k lines of UI, 15k lines of core packages and the
  main-side services are rewritten in Rust. Phase 0, the gate, is L.
- **Risk**: HIGH for the code. Tidy's executor, which moves files and keeps the undo journal,
  becomes a second, new implementation. The sandbox and the differential tests keep that away
  from the owner's archive.
- **Depends on**: nothing open; 059 merged in #187.
- **Planned at**: commit `4c76020b`, 2026-10-27

## What the experiment answers

Electron Oriel works. It is 503 MB on disk (this Mac's 0.1.4 `.app`), and it runs a Chromium
renderer and its GPU process beside the main process and the utility workers. The questions:

- Is Oriel built natively on GPUI clearly better to use? Faster to start, lighter in memory,
  smoother through a large gallery, and native in feel.
- Can its engines be ported to Rust faithfully: the same order, the same plans, the same files
  after a change?
- What does keeping two implementations in step cost?

The plan builds Oriel again, measures it against Electron Oriel on the same archive, and hands
the owner the numbers.

## Settled by the owner (2026-10-27 and 28, do not re-ask)

1. **A full port, with no Node at runtime.** Every engine runs in the app's own process:
   Tidy's, View's media index and thumbnails, and Sync's. The UI is GPUI throughout, with no
   webview and no HTML. ffmpeg and ffprobe stay as bundled tools run as child processes, as in
   Electron Oriel. That part is an assumption, since they are not Node; say so if they must go
   too, and linking FFmpeg's libraries becomes Phase 1 work.
2. **Not Oriel's data, for now.** Oriel RS neither reads nor writes `~/.latch-works/oriel`,
   `frame-view`, `glazier`, `lockstep`, `lockstep.json` or `hash-cache`. Everything it keeps is in
   `~/.latch-works/oriel-rs/`. Using Oriel's data is a later plan.

On Phase 0's report (2026-10-28):

3. **Go.** Development continues past the gate.
4. **Video plays through libmpv**, for mpv's full capabilities: every container and codec
   (including the MKV, WebM, AVI, FLV and ASF files AVPlayer refuses) and exact AV1 seeks. This
   replaces "AVPlayer into `surface()`" as the video path; the AVPlayer player stays until libmpv
   passes Phase 0's video rows. Two things to settle when it is built: an LGPL build of libmpv
   (mpv is GPL unless built with `-Dgpl=false`), loaded at run time as libvips is; and how its
   frames reach GPUI, whose `surface()` takes only `420f` pixel buffers on macOS.
5. **Han ordering.** The 19 pairs where ICU4X and Node's ICU differ are accepted as documented
   differences. Rust orders them as Electron Oriel does.
6. **libvips in the app.** Carrying sharp's libvips build (about 18 MB) for exact fingerprints is
   accepted.

## Which GPUI (D1, settled: A)

**Settled by the owner on 2026-10-28: A, GPUI Kit on Zed's GPUI.** The record below is why.

### The fork, and what has happened since

- **2025-10-22.** Zed publishes `gpui` 0.2.2 to crates.io. It is still the latest official
  release a year later. Zed's README calls GPUI pre-1.0, "in active development as we work on the
  Zed code editor".
- **2025-12-12.** Mikayla Maki, who maintains GPUI at Zed, closes an outside PR for custom
  shaders ([zed#42905](https://github.com/zed-industries/zed/pull/42905)): "we're shifting focus to
  core product work at Zed, and without a Zed use case, I can't validate this code." PRs for tray
  support, iOS and Android backends and Wayland touch events were closed too, and 13 Zed PRs now
  mention GPUI-CE.
- **2025-12-12, eight minutes later.** [gpui-ce/gpui-ce](https://github.com/gpui-ce/gpui-ce),
  the GPUI Community Edition, is created. Nate Butler opens its first issue and publishes its
  first crates; he designed Zed (1,189 commits in its history) and is now at GitHub Next. CE's
  site says GPUI "was built to serve one editor's roadmap" and that CE exists so it can "grow
  independently".
- **2026-04-09.** Jason Lee (`huacnlee`), who leads GPUI Kit at Longbridge, declines to move the
  kit onto a community fork. Paraphrased: frameworks survive when a real product drives them, as
  Zed drives GPUI and Longbridge Pro drives the kit. He grants that GPUI "is indeed facing
  slightly slower progress due to Zed's needs".
- **Instead, Longbridge publishes GPUI itself.**
  - `gpui-pre` is a weekly snapshot of Zed's GPUI (0.3.10 is `zed@08cbb88`, 2026-10-26).
  - [GPUI Fast](https://github.com/longbridge/gpui-fast) (2026-09) is its performance fork: a
    retained mode, cached scroll layers, and native views composed under GPUI's overlays.
- **2026-08-28.** CE's maintainers fork GPUI Kit as
  [gpui-ce/gpui-component](https://github.com/gpui-ce/gpui-component): the same components on CE.
  It has 17 stars and one crates.io release (`gpui_ce_components` 0.2.0, 2026-08-29). Its main
  branch moved to CE 0.3 on 2026-10-22 to 27.
- **2026-09 to 10.** CE merges what Zed declined: a custom GPU rendering API (#237) and an
  opt-in wgpu renderer on macOS (#287). With them an app draws its own GPU textures, such as
  video frames, through `SurfaceSource::Texture`.
  - Not yet on Windows. Surfaces were enabled there on 2026-09-01 (#121), but CE's WGPU
    migration (#215) removed the Windows wgpu renderer six days later. The PR that brings it
    back, #313, has been open since 2026-10-03, and `gpui_ce_windows` 0.3.0 has no `wgpu`
    feature.
  - CE 0.3.0 came out on 2026-10-20. It is diverging from upstream on purpose: a new text system
    (parley), a split `AppContext`, colors as `Background`, transitions, backdrop blur and smooth
    corners.

### The two lines

The choice is not "a kit or GPUI-CE". Both lines have GPUI Kit's components. The choice is which
GPUI to stand on.

| | A. GPUI Kit on Zed's GPUI | B. GPUI-CE with its port of GPUI Kit |
|---|---|---|
| Driven by | Longbridge, for its shipped Longbridge Pro, on Zed's GPUI snapshotted weekly | CE's community maintainers, independent of Zed |
| Releases | Weekly; GPUI Kit 0.8.1 pins `gpui-pre` exactly | `gpui-ce` 0.2.2 (Aug), 0.3.0 (Oct), with a changelog of breaking changes. The component port has one release, and CE 0.3 support only on its main branch. |
| Components | First-party: 75+, 18.7k stars, docs at gpui-kit.com | The same components, rebased onto CE by a few people |
| Windows video | No released zero-copy path. Options: a new `RenderImage` per frame (Zed's own path off macOS); GPUI Fast's native composition (experimental); GPUI Fast's streaming textures (gpui-fast#86, open) | No released zero-copy path either. Texture surfaces wait on #313 (open), then a `RenderImage` per frame |
| Extras | GPUI Fast's retained mode, AccessKit, headless UI tests, skills for agents | Smooth corners, backdrop blur, transitions, mobile and web backends |
| Work written by agents | GPUI Kit ships `AGENTS.md`, `CLAUDE.md` and skills, and its lead welcomes agent-related changes | CE's core forbids AI-made commits and prose, so our core fixes stay local. Its kit port still has agent files and merged a Codex-built PR on 2026-10-27. |
| If it stalls | One person (`huacnlee`) owns the crates. The way out is cheap: each snapshot names its Zed commit, so a git pin of that commit is the same code (C). | Three volunteers write 84% of CE's commits. The kit port is 224 commits behind GPUI Kit, and its publisher calls it "a pain to keep up to date". |
| Adoption, last 30 days | `gpui-pre` 235,735 downloads, `gpui-kit` 162,612. Apps include Longbridge Pro, BongoCat 2.0 (24.3k stars), Zedis and Navop. | `gpui-ce` 10,964, `gpui_ce_components` 682. The largest app is Look (1.2k stars). |

**Recommendation: A.**
- The problem CE solves, Zed not taking outside GPUI work, is one Longbridge already solves for
  GPUI Kit users: it publishes GPUI weekly and forks it when it needs to.
- The port's UI is 24.8k lines of screens on components, so the kit's maturity matters most, and
  CE's port of it is two months old.
- Agents will write most of this port. GPUI Kit is built for that. Most of the video and platform
  work would touch CE's core, which takes no AI-made contributions.
- Neither line has a released Windows path for video textures, so Windows does not argue for B
  today.
- Developers lean the same way, if thinly. Since the fork, 12 independent voices or project
  moves favour A and 6 favour B, and nobody argues for plain upstream. Three projects moved from
  CE to A and one from A to CE. See [the sentiment research](../research/gpui-line-sentiment.md).

**Choose B** if standing apart from both Zed and Longbridge matters more than the kit's maturity.
The plan is written for A. Under B:
- Phase 0 pins `gpui-ce` and `gpui-ce/gpui-component` by commit;
- no skills are vendored;
- Windows video waits on #313.

**Revisit** when one of these happens:
- CE releases Windows texture surfaces (#313), and A's Windows routes fail in Phase 8.
- No `gpui-pre` snapshot appears for about four weeks. Then move to C at the last snapshot's Zed
  commit.
- Zed publishes `gpui` to crates.io again, which makes C first-class.
- CE's kit port stays within weeks of GPUI Kit, CE has documentation, and its work spreads beyond
  three people.

**Other toolkits considered** (2026-10-27,
[research](../research/rust-gui-alternatives.md)):
- Slint is the strongest pure-Rust alternative.
- Qt, through Qt Bridge for Rust (a Technology Preview until a stable release planned for Q1
  2027), has the best video and widgets. It is the first fallback if Phase 0's video gate fails.
- iced has no accessibility. Dioxus Native's engine is in beta. raylib is a game library.

None beats GPUI Kit for Oriel today.

Moving from A to C is a pin change. Moving from A to B means adapting to CE's deliberate core
changes: wide, but mostly mechanical, since CE's kit port keeps GPUI Kit's component API.

## Ground rules

- **Its own app and data.** Product name "Oriel RS", bundle id
  `dev.traydr.latchworks.oriel-rs`, executable `oriel-rs`. It installs beside Oriel and keeps
  everything in `~/.latch-works/oriel-rs/` (`shell/`, `view/`, `tidy/`, `sync/`, `hash-cache/`).
  The paths crate has one root, and a test fails if any path it hands out leaves it.
- **Tidy works in a sandbox.** Tidy refuses a root outside `~/.latch-works/oriel-rs/sandbox`
  and the temp folder. Agents build archives there with `e2e/src/glazier-archive.ts`.
  - The sandbox setting stays hidden until Phase 6's differential suite passes and the owner has
    read its report. Even then the owner lifts it, not an agent.
  - The owner's library is tidied by Electron Oriel. The sandbox also keeps two apps from
    rewriting the same files.
- **View reads; Sync goes to the local stack.** View never writes inside a root, so the owner may
  point it at the real library themselves. Agents use the fixture archives
  (`e2e/scripts/make-fixture.ts`). Sync pushes only to the local compose stack
  (`docs/localhost`), never to the Railway Pane View.
- **Numbers, not content.** The library is adult content. Reports, screenshots and Vellum
  uploads carry counts, sizes and timings, never its frames, thumbnails or file names.
  Screenshots of fixture archives are fine.
- **Electron Oriel and the TypeScript packages keep working.** Pane View, the Lockstep CLI and
  Gather Box still use them. This plan adds conformance vectors and a few test exports to them,
  each in its own commit, and their suites must pass after each.
- **Commits.** One branch per phase, from `agent/063-0-spike`; subjects read
  `type(oriel-rs): …`. Push when the owner asks.

## Settled by default (change by saying so)

1. **Same formats, separate folders.** The Rust code writes what Electron Oriel writes:
   - the same SQLite schemas at the same `user_version`, for Tidy's catalog, View's index and the
     hash cache;
   - the same settings files;
   - the same secret-storage file (AES-256-GCM under a 0600 key file).

   Tests check it on files each implementation makes in a temp folder. Then a later plan can
   point Oriel RS at Oriel's data with a switch, not a conversion. If the owner would rather
   the port design its own schemas, say so. That frees the port and makes the later plan a
   migration.
2. **Where it lives.** `apps/oriel-rs` is a Cargo workspace with `Cargo.lock` committed and
   `rust-toolchain.toml` pinning stable (1.99.1 here). A thin `package.json` wraps `cargo` for
   `pnpm --filter @latch-works/oriel-rs dev` and `check`. It has no `build`, `test` or
   `package` script, because `pnpm build:all` and `pnpm test` run those in every workspace;
   packaging gets another name in Phase 1.
3. **Platforms.** macOS arm64 first. Windows x64 is Phase 8, a gate of its own. No Linux.
4. **Pins.** `gpui-kit = "=0.8.1"` exactly, as GPUI Kit pins `gpui-pre`. Bump deliberately, one
   bump per PR, never as part of a feature.
5. **Same app shape** as Electron Oriel: View · Tidy · Sync, ⌘1–3, Tidy's pages on ⌥⌘1–7, the
   rail on ⌘\, Settings on ⌘,. Hidden modes keep their state, and closing the window quits unless
   a push or a Tidy change runs (059's decisions 2–3).
   - In GPUI a hidden mode's entities simply live on.
   - Keys reach actions through the focused element's key context. So a hidden mode cannot
     receive keys, which removes 059's "listeners only while active" risk by construction.
6. **House style as a GPUI Kit theme.** The `lw-*` tokens in `apps/oriel/src/index.css` become
   light and dark theme files: the system font at 13 px, 32 px controls, rounded surfaces lifted
   by a soft ring rather than hairlines, neutral selection, and one violet accent per screen.
   GPUI Kit's defaults are shadcn's and must be overridden where they differ. The icons are
   Lucide, as Oriel's are.
7. **Agent skills.** Review GPUI Kit's two skills and vendor them into `.claude/skills/` in
   Phase 0, since they are third-party instructions (under D1 = A only).

## Target shape

```text
apps/oriel-rs/
  Cargo.toml, Cargo.lock, rust-toolchain.toml, package.json
  crates/app/           main: the window, menus, mode host, background executors, Dock, Trash,
                        open-file, window state
  crates/ui/            the house kit on GPUI Kit: theme files, top bar, rail, float panel, toasts
  crates/media/         stills (ImageIO), video (AVPlayer into surface()), decoded-image cache
  crates/core-paths/    app-data: every folder under ~/.latch-works/oriel-rs, and nothing else
  crates/core-domain/   media-domain: sort and natural order, paths, comics, browser entries
  crates/core-format/   media-format: still and video policy, AVIF settings, file names
  crates/core-index/    media-index: archive scan, sync plan
  crates/core-sync/     lockstep-core: hash cache, plan, push, prune, doctor, Pane View client
  crates/core-tidy/     glazier-core: catalog, scan, passes, duplicates, similarity, plans,
                        executor, holding, optimize
  crates/tools/         ffmpeg and ffprobe: pinned binaries, a runner with timeouts and kill
  crates/mode-view/     gallery, folder overlay, viewer, capsule player, comic reader, index,
                        thumbnails
  crates/mode-tidy/     Overview, Library, Duplicates, Clean up, Convert, Shrink, Holding, History
  crates/mode-sync/     profiles, secret storage, plan tree, run panel, run log
  conformance/          vectors made by the TypeScript packages, read by both test suites
  scripts/              vector generation, fixtures, packaging
```

```text
+- Oriel RS.app: one Rust process -------------------------------------------------+
|  UI thread: GPUI Kit views for View, Tidy and Sync; menus, dialogs, Dock, Trash    |
|  stills through ImageIO; video through AVPlayer into surface(); WebP thumbnails    |
+------------------------------------------------------------------------------------+
|  background executors: Tidy's engine (catalog, passes, plans, executor), View's    |
|  index and thumbnails, Sync's runs (tokio, reqwest); one SQLite thread per catalog |
+-----------------+-------------------------------------------+----------------------+
                  | child processes                           | HTTPS
           ffmpeg, ffprobe                             local Pane View only
   writes only ~/.latch-works/oriel-rs/; Tidy changes only roots in its sandbox
```

## What is ported

| TypeScript today | Lines | Rust | Notes |
|---|---:|---|---|
| `media-domain` | 598 | `core-domain` | Natural order with ICU4X's collator (numeric, base strength), as `Intl.Collator` does |
| `media-format` policy | 615 | `core-format` | Mediabunny's animation path becomes ffmpeg's |
| `media-index` | 583 | `core-index` | |
| `app-data` | 111 | `core-paths` | One root, `~/.latch-works/oriel-rs` |
| `lockstep-core` | 2,621 | `core-sync` | A bounded upload queue, 1–8 wide and 3 by default (plan 036) |
| `glazier-core` | 10,588 | `core-tidy` | The largest port. `plans/` (planner, executor, holding, journal) is 2.7k of it. |
| View's main side | 6.7k with Electron hosting | `mode-view` | Index, thumbnail broker, media tools, settings |
| Sync's main side | 2.2k with hosting | `mode-sync`, `core-sync` | Profiles, runs, `FileSecretStorage` |
| Tidy's hosts | 2.3k | none | The engine host, AVIF pool, transcoder window, protocol and IPC all go: the engine runs on background threads |
| Renderers, shell, `ui/` | 24.8k | `ui`, `mode-*` | GPUI Kit |

Library defaults, confirmed or replaced in Phase 0:

| Need | Electron Oriel | Oriel RS |
|---|---|---|
| SQLite | `node:sqlite`, Drizzle for View's index | `rusqlite` with bundled SQLite |
| SHA-256 | `node:crypto` | `sha2` |
| Natural order | `Intl.Collator` | `icu_collator` (ICU4X) |
| Fingerprints | sharp (libvips) | sharp's own libvips build, loaded at run time through a small binding: bit for bit in Phase 0, where the `image` crates were not |
| Thumbnails | sharp (libvips), WebP | ImageIO decodes, libwebp encodes (ImageIO writes no WebP) |
| AVIF encodes | libavif in wasm (`@jsquash/avif`), sharp for the largest | libavif with aom at `media-format`'s settings. The `libavif` crate needs cmake and bundles an old libavif; Phase 0 linked Homebrew's through a C shim. Phase 1 chooses. |
| AVIF and HEIC for display | Chromium | ImageIO on macOS; dav1d on Windows |
| Video playback | Chromium's `<video>` | AVPlayer into `surface()` on macOS |
| Video and animation conversion | Mediabunny over WebCodecs, ffmpeg as fallback | ffmpeg, with the fallback's arguments |
| Probe, loudness, frames | ffprobe and ffmpeg | The same, through `crates/tools` |
| HTTP to Pane View | `fetch` | `reqwest` on a tokio runtime |
| Secrets | `FileSecretStorage` | `aes-gcm`, the same file format |
| Trash, Dock, open-file | `shell.trashItem`, `app.dock`, `open-file` | `trash`, `NSDockTile` through `objc2`, GPUI's `on_open_urls` |

## Keeping two implementations honest

The TypeScript packages stay, since Pane View, the Lockstep CLI and Gather Box use them. So every
rule now exists twice. These checks make a difference between the two fail a test rather than
reach a file.

- **Conformance vectors.** A Vitest suite in each package runs the real TypeScript over fixed
  inputs and checks `apps/oriel-rs/conformance/<package>/*.json`; with an update variable set
  it rewrites them instead. `cargo test` checks that Rust produces the same, so a change on either
  side shows as a diff of the vectors. They cover:
  - `media-domain`'s sort orders, natural order, paths, comic grouping and browser entries;
  - `media-format`'s still and video policies and file names;
  - `media-index`'s sync plan;
  - `glazier-core`'s sniffing, keeper choice, duplicate sets, conversion candidates and Shrink's
    estimate;
  - fingerprints of a fixed image corpus.

  They pin ordering rules, sync invariants and parser output, which the testing guidelines say to
  commit.
- **Differential Tidy runs.** `glazier-core`'s engine harness and the Rust engine each take their
  own copy of one throwaway archive and make the same decisions. Then compare:
  - the resulting trees (paths, sizes, hashes), holding, and each plan's steps;
  - the same again after Undo.

  This covers every e2e Tidy case: Convert, Clean up, Shrink, Tidy up, duplicates and Spot
  variants.
- **Same formats.** Each implementation creates a catalog, an index and a hash cache in a temp
  folder. Compare `sqlite_master` and `user_version`, then have each read the other's files. The
  secret file gets the same check.
- **Pane View's API.** The Rust client's types are generated from `lockstep-core`'s zod schemas
  (`z.toJSONSchema`, then `typify`), and a check fails when they are stale. Against the local
  stack, a plan the Rust client makes for a source equals the Lockstep CLI's plan for it.
- **Fingerprints exactly.** Spot variants' thresholds were measured on the owner's library, and
  agents cannot re-measure them. So the Rust fingerprints must equal `glazier-core`'s bit for bit
  on the corpus. STOP if no Rust image pipeline does, and ask the owner.

## Media in GPUI

GPUI has no video element. Its image decoder has no AVIF or HEIC, and AVIF is the archive's still
format. Phase 0 proves these paths on macOS before anything else is built.

- **Thumbnails.** View's thumbnail service, now Rust, writes WebP to
  `~/.latch-works/oriel-rs/view`, and GPUI's `img(path)` decodes it. The gallery asks for the
  visible range. GPUI's image cache is not bounded (Phase 0 found 11.5 GB after one scroll), so
  every `img()` carries the app's own LRU cache.
- **Stills.** Decode with ImageIO (`CGImageSource`), which reads AVIF, HEIC, JPEG, PNG, WebP and
  GIF on macOS 13 and later.
  - Decode at the size the screen needs, applying EXIF orientation, into a `RenderImage`.
  - Keep a small cache of decoded neighbours, so arrow-stepping in the viewer is instant.
  - GIFs animate through GPUI's own decoder. The archive turns animations into MP4 anyway.
- **Video on macOS.** Use `AVPlayer` with an `AVPlayerItemVideoOutput`. Pull a `CVPixelBuffer` per
  display frame and draw it with `gpui::surface()`, which is how Zed draws call video on macOS.
  - AVPlayer owns decoding, sound, sync, seeking, volume and rate, with hardware decode. That
    covers H.264, HEVC and AV1, the last being what Shrink writes. AV1 needs an M3 or later, which
    the owner's M5 Pro is.
  - The capsule player's controls are GPUI drawn over it.
  - Duplicates plays several tiles at once, so measure several players together.
  - GPUI's surface shader always uses the BT.601 matrix and panics on any pixel format but
    `420f`. The player asks AVFoundation for BT.601 `420f` frames until GPUI reads the buffer's
    colour tag.
  - AV1 from SVT-AV1's default encode seeks only to the keyframe before the target in
    AVFoundation (Phase 0); see the Phase 0 report for the choices.
  - The window lifts GPUI's 30 fps cap on inactive windows, so video behind another window keeps
    its rate.
- **Video AVPlayer cannot play.** MKV, WebM, AVI, FLV and ASF are the files Tidy converts to MP4.
  They show their poster with "Can't play <format> here; Convert makes it MP4", and the scorecard
  counts them.
  - The fallback, if the owner wants them playable, is libmpv's render API, with frames as
    textures. It is another large native library and needs a licence check, so it is a decision,
    not a default.
- **Video on Windows (Phase 8).** No line has a released zero-copy path: Zed's DirectX
  `draw_surfaces` is a no-op, and CE's Windows wgpu renderer waits on #313. Frames come from
  Media Foundation's `IMFMediaEngine` in frame-server mode. Under A, measure three ways of showing
  them:
  - a `RenderImage` per frame, which is Zed's path, measured with Duplicates' several players at
    once;
  - GPUI Fast's streaming textures, if gpui-fast#86 lands;
  - a native video surface composed under GPUI with GPUI Fast.

  Under B, a `RenderImage` per frame until #313 is released.
- **PDFs.** View does not read PDFs yet (plan 040), so neither does this. Tidy lists them as
  files.

## Phases

Each phase ends with its parity cases and conformance vectors passing, and a short report:
numbers, not content.

### Phase 0: the spike, and the gate (L)

Prove the riskiest UI and the riskiest ports on fixtures, then measure them against Electron
Oriel.

1. **Scaffold** `apps/oriel-rs` with `gpui-kit` pinned, and add `apps/oriel-rs/target/` to
   `.gitignore`.
   - One window with a transparent title bar and the traffic lights inset.
   - A sidebar with the View · Tidy · Sync switcher, ⌘1–3 as actions, and the native menu.
   - A first cut of the house theme.
2. **Fixture.** A script makes a fixture archive in the sandbox:
   - 20,000 stills, mixed AVIF and JPEG;
   - 300 videos, H.264, HEVC and AV1, 720p to 1440p (`testsrc2` with noise, as
     `e2e/tests/glazier/shrink.spec.ts` makes them);
   - 40 comic folders.
3. **UI.** Each measured for frame time (GPUI's `profiler` feature and GPUI Kit's `gpui-fps`)
   and memory, with and without `gpui-fast`:
   - the virtualized gallery, `uniform_list` rows of N tiles as `useVirtualGridMetrics.ts`
     computes them, with thumbnails a first Rust thumbnail service writes;
   - the viewer on ImageIO, with arrows, prefetch and Escape;
   - the capsule player on AVPlayer into `surface()`, on each codec (open, seek, skip, mute, play
     and pause, sound in sync), then four Duplicates-style tiles playing at once;
   - GPUI Kit's data table with 100,000 rows: sort, scroll and select.
4. **Ports.**
   - Generate the first vectors and pass them in Rust: natural order and sort orders. ICU4X
     against ICU4C, the riskiest small rule.
   - Fingerprint parity: bit-for-bit equal fingerprints from libvips bindings or from the `image`
     crates, on the corpus.
   - Scan and SHA-256 throughput on the fixture against `glazier-core`'s.
   - One AVIF encode at `media-format`'s settings through libavif, against the wasm encoder's size
     and quality on the same stills.
5. **Baseline.** Measure Electron Oriel, built from the same commit, on the same fixture.
   `e2e/scripts/frame-performance.ts` already drives View, so extend it rather than write a
   second harness.

**Done when** the scorecard's Phase 0 rows have numbers for both apps and each port check has a
result. Then stop and report; the owner decides go or no-go, and D1.

**Done 2026-10-28**: [docs/research/oriel-rs-phase0.md](../research/oriel-rs-phase0.md). The
baseline lives in `e2e/scripts/frame-performance.ts`'s fixture mode (`FRAME_PERF_FIXTURE_ROOT`).

**STOP** if any of these fail:
- video through `surface()` seeks with sound in sync;
- the gallery scrolls at least as well as Electron Oriel's;
- ImageIO decodes the fixture's AVIFs;
- some Rust image pipeline matches the fingerprints exactly;
- ICU4X matches the order vectors. If it does not, report the differing strings; the owner may
  accept a documented difference.

### Phase 1: foundations (M)

1. **`core-paths`**, with the root test from the ground rules.
2. **`core-domain` and `core-format`**, passing their vectors.
3. **Background work.**
   - A small job runtime on GPUI's background executor, with cancellation, progress and errors
     that reach the UI.
   - A tokio runtime on its own thread for HTTP.
   - One SQLite connection per catalog, on its own thread.
4. **`tools`.** Pinned ffmpeg and ffprobe, reusing `apps/oriel/media-tools.ts`'s URLs and hashes
   so both apps run the same builds. Port `run-tool.ts`: timeouts, kill on cancel, and stderr
   kept for messages.
5. **The conformance harness.** The vector script, the Vitest suite in each package that has
   vectors, and the `cargo test` side.
6. **`pnpm oriel-rs:check`**: `cargo fmt --check`, `clippy -D warnings`, `cargo test` and
   vector freshness.

**Phase 1 results (2026-10-28).** All six steps are done, plus `docs/runbooks/oriel-rs.md`, the
`oriel-rs.yml` workflow and the libmpv video path the owner chose. 111 Rust tests pass.
- **Rules.** `core-domain` now holds all of `media-domain` and `core-format` the policies of
  `media-format`, each pinned by vectors from its package's Vitest suite. Beyond the 19 accepted
  Han pairs there is no difference. Matching needed V8's `Math.log`, JavaScript's `toFixed`
  rounding and its `trim` set in Rust. Paths are `&str`, so a Windows name holding a lone
  surrogate is Phase 8's problem.
- **Animation conversion is not "ffmpeg with the fallback's arguments".** Mediabunny and the
  ffmpeg fallback differ on short GIF delays (ffmpeg makes under 20 ms into 100 ms; Mediabunny
  raises under 10 ms to 10 ms), odd sizes (crop against pad), the key-frame interval (none against
  every 2 s) and quality. `core-format` exposes Mediabunny's decisions for Phase 6 to hand
  ffmpeg.
- **Runtime.** `oriel-runtime` has jobs as GPUI entities (merged progress, one finish, panics as
  failures, cancel by token or by dropping), a tokio thread whose tasks GPUI can await, and one
  SQLite thread per catalog with Electron Oriel's pragmas and `user_version` migrations. It waits
  5 s on a locked catalog where `node:sqlite` waits 0, since nothing else shares its files.
- **Tools.** `oriel-tools` fetches the same ffmpeg and ffprobe as Electron Oriel
  (`cargo run -p oriel-tools --bin fetch-media-tools`), refusing a hash mismatch; a test fails
  if its pins and `media-tools.ts` differ. `ORIEL_RS_MEDIA_TOOLS` wins over the bundle and the
  dev cache, and `PATH` is never searched. The runner ports `run-tool.ts`.
- **libmpv.** Behind `ORIEL_RS_VIDEO=mpv`, mpv's OpenGL renderer draws into an IOSurface,
  which VideoToolbox converts to BT.601 `420f` for `surface()`: hardware decode, no CPU copy,
  colour within 1 level. On the 300 fixture videos every exact seek, AV1 included, lands on its
  target (181–210 ms median), and MKV, WebM, FLV, AVI and ASF play. The cost against AVPlayer:
  opens take 85–97 ms against 61–65, exact seeks on H.264 and HEVC are slower, and CPU is about
  1.7–1.8 times AVPlayer's (four 1440p60 tiles: 69–75 % against 41 %). The spike loads IINA's
  libmpv, a GPL build, which must never ship; an LGPL build (mpv `-Dgpl=false`, FFmpeg without
  `--enable-gpl`) loses nothing playback needs.

**Questions for the owner from Phase 1:**
1. **libmpv as the default.** Make it the default video engine now, at the CPU and latency cost
   above, or keep AVPlayer as the default for MP4 and use libmpv for what AVPlayer cannot play or
   seek (AV1 and the other containers)?
2. **Building an LGPL libmpv** needs meson, ninja and pkg-config (via Homebrew), then a pinned
   script that builds mpv, FFmpeg, libplacebo and libass from source. May the agents install those
   tools? Until then the switch keeps loading IINA's libmpv for development only.

### Phase 2: the shell (M)

1. **Layout A in GPUI Kit.** The mode switcher sits under the traffic lights, with the mode's
   navigation below it. The rail form stacks the icons (88 px on macOS), toggled with ⌘\. The
   52 px top bar has the rail toggle first.
2. **Menus per mode.** `cx.set_menus` swaps the active mode's File and View items in.
3. **One Settings page** (⌘,). General holds the theme (System, Light, Dark) and the data folder,
   then comes a section per mode. Settings sits at the bottom left of every sidebar.
4. **Shell services.**
   - Toasts.
   - Window state, and reopening on the last mode and page.
   - Dock progress while a run goes on.
   - Paths the OS opens go to View.
   - Quitting waits for a running push or Tidy change, with the window hidden.
5. **Activity on the switcher**: a ring while a push or a Tidy change runs, a dot while a scan
   or analysis does.
6. **Accessibility.** VoiceOver reads the switcher, the sidebar and the top bar by their names.

**Done when** `shell.spec.ts`'s cases pass as GPUI tests: it starts in View, switches from the
switcher and the menu, reopens on the last mode and page, keeps View's folder while another mode
shows, and has one Settings page at the mode's section.

### Phase 3: View (L)

1. **`core-index`**, with View's media index in the same schema as Electron Oriel's. The scan
   follows the same rules: system folders skipped, no symlinks followed, the bounded pools of
   plan 035.
2. **The thumbnail service and media tools**: WebP at the broker's sizes, video frames through
   ffmpeg, ffprobe for durations. Settings and remembered folders follow.
3. **The UI** on Phase 0's gallery, viewer and player. Every behaviour in
   `e2e/tests/frame-view/gallery.spec.ts`:
   - open a folder, list its children, and recurse on demand;
   - excluding a root child drops its subtree;
   - filters for images and videos;
   - the configured sort order, in the shared ordering rules;
   - Random, and Shuffle;
   - every tile has a thumbnail;
   - double-click opens the viewer, the arrows step and Escape closes;
   - the capsule player;
   - comic mode and the reader;
   - the remembered folder.

   Then View's settings groups and Diagnostics. 057's toolbar decisions stand: order, visible
   labels and button names.

### Phase 4: Sync (L)

1. **`core-sync`.**
   - The hash cache, in `~/.latch-works/oriel-rs/hash-cache`.
   - Plan, push and prune, with the checksum and length headers plan 026 signs.
   - The doctor.
   - The Pane View client on the generated types.
2. **Profiles and secrets.** The token is entered once and stored the way `FileSecretStorage`
   stores it, never in the settings file in the clear.
3. **The UI.**
   - Profiles in the sidebar.
   - The plan tree as the page, and push with the run panel floating.
   - The run log.

**Done when** `e2e/tests/lockstep/sync.spec.ts`'s five cases pass against the local stack, and a
Rust plan equals the Lockstep CLI's for the same source.

### Phase 5: Tidy's engine, part one: knowing the archive (L)

`core-tidy`'s catalog, in the same schema and migrations as `glazier-core`'s. Then the scan:
walking roots, sniffing, the junk rules (`.DS_Store`, `desktop.ini`, `Thumbs.db`), and hashing.
Then the passes: probe, loudness, fingerprints and detail prints. Then duplicate sets with the
keeper, similar groups, and Spot variants. Every stage passes its vectors, and Overview's numbers
for a fixture archive equal Electron Oriel's.

### Phase 6: Tidy's engine, part two: changing the archive (XL)

Each of these steps passes its differential runs before the next one starts:
1. **The planner, the executor, holding and the journal.**
   - The executor re-reads each file and skips one that changed since the scan.
   - Holding sits outside the root, by rename where the volume allows.
   - Each step has its own Undo, and emptying holding goes to the Trash.
   - The open-file handling of plan 062 (EPERM is "in use" only on Windows).
2. **Clean up.**
3. **Convert.** Stills to AVIF through libavif, video and animation to MP4 through ffmpeg.
   Dates are kept.
4. **Shrink.** SVT-AV1 at CRF 35, the estimate, and the timings it learns.
5. **Tidy up**, as one change with one Undo.

**Done when** the differential runs pass for every e2e Tidy case. The owner then reads the report,
and decides whether to show the sandbox setting.

### Phase 7: Tidy's UI, and the links (XL; a PR per page)

1. **The pages.**
   - Overview.
   - Library: the data table, the filter menu and the Inspector.
   - Duplicates:
     - the version grid with playing tiles, the copy list and the loupe;
     - Return keeps the suggestion and moves on;
     - Undo per decision;
     - Spot variants' options in the top bar.
   - Clean up, Convert, Shrink, Holding and History.
   - Tidy's settings, and the folder picker.
2. **The parity cases.** Port the nine cases in `e2e/tests/glazier/`.
3. **Links between the modes.**
   - Open in View from Tidy's tiles, rows, copies, loupe and Overview.
   - Show in Tidy from the viewer.
   - Sync this folder from Tidy's Overview.
   - Open in View and Tidy this folder from Sync's profile menu.
   - Folders one mode works on are offered to the others.
4. **The first-run welcome**, asking for one folder for View and Tidy (Tidy's inside the sandbox).

Port `links.spec.ts` and `welcome.spec.ts`; `migration.spec.ts` does not apply.

### Phase 8: Windows x64 (L, a gate of its own)

GPUI renders with DirectX 11 on Windows. Five things need building or choosing:
- the video path (see Media);
- an AVIF decoder (dav1d through the `image` crate's `avif-native`, or WIC with the AV1
  extension, which is not always installed);
- the caption buttons and Mica;
- a single-instance lock, since LaunchServices keeps one instance on macOS but Windows does not;
- `vpk pack` over the Rust build.

Re-run plan 062's Windows checks on a throwaway archive: files held open, drives, long paths,
names, Explorer's files and hard links. Those were fixes in TypeScript, so each must be redone in
Rust. **STOP** and report if video cannot reach 60 fps at 1080p on the owner's Windows machine.

### Phase 9: the scorecard and the decision (S)

Run the scorecard on release builds of both apps. Then write
`docs/research/oriel-rs-scorecard.md` with the numbers, the catch-up list of Electron features
that landed meanwhile, and what is still missing. The owner decides:
- go on toward replacing Electron Oriel, which needs a new plan for using Oriel's data and
  retiring the Electron app;
- keep it as an experiment;
- or stop and delete the workspace.

## Scorecard

Both apps run as release builds on the same Mac and the same fixture, each measured three times;
report the median.

| Measure | How |
|---|---|
| Size on disk | `du -sh` of the `.app` (Electron Oriel 0.1.4: 503 MB) |
| Cold start | Launch to the first gallery frame with thumbnails drawn |
| Memory at rest | All the app's processes' resident memory, 60 s after opening View |
| Memory after scrolling | The same, after scrolling the 20k gallery top to bottom |
| Gallery scroll | p50 and p95 frame time while scrolling at a fixed speed |
| Viewer step | Arrow key to the full still on screen, on AVIF and JPEG |
| Video | Open to first frame, and seek to first frame, on each codec |
| Library table | Sort time and scroll frame time with 100k rows |
| Tidy analysis | Scan to a finished Overview on the fixture |
| Sync | Plan and push of the fixture to the local stack |
| CPU at rest | Mean CPU over 60 s, idle in each mode |
| Unplayable | Fixture files the app cannot show |

Plus what numbers miss: the owner's feel after a day's use, text rendering, keyboard behaviour,
VoiceOver, and the lines of code each app needs for the same features.

## Verification

```sh
pnpm oriel-rs:check      # cargo fmt --check, clippy -D warnings, cargo test, vector freshness
pnpm test && pnpm typecheck && pnpm lint:all && pnpm knip   # the TypeScript side, with vectors
pnpm e2e:frame && pnpm e2e:glazier && pnpm e2e:lockstep && pnpm e2e:oriel   # Electron Oriel intact
```

- **The parity list** is Oriel's 33 e2e cases, minus the migration case. Each phase ports its
  cases to GPUI Kit's headless UI tests (the `test-support` feature). They render real views,
  drive keys and the pointer, run the real engines on a fixture archive, and assert on what is on
  screen and on disk.
  - Playwright cannot drive GPUI, so these replace it for this app.
  - Commit the cases that pin behaviour: the parity list, the vectors, the differential runs and
    the format checks.
- **`cargo` stays out of `pnpm test`**, so the TypeScript side still builds without Rust. Biome
  and Knip ignore `apps/oriel-rs/crates` and `target/`.
- **CI.** An `oriel-rs.yml` workflow runs `pnpm oriel-rs:check` on demand and on PRs touching
  `apps/oriel-rs` or the vectors.
- **Docs.** When Phase 1 lands, add a short `docs/runbooks/oriel-rs.md` (prerequisites: Rust
  through rustup, Xcode, and Node 24 with pnpm 12 for the vectors) and one line in `CLAUDE.md`'s
  project structure.

## Risks and STOP conditions

- **A second executor.** The code that moves the owner's files is new. It stays sandboxed until
  the differential suite passes and the owner lifts the sandbox. STOP if any step would:
  - open a path outside `~/.latch-works/oriel-rs`;
  - run a Tidy change on a root outside the sandbox before the owner lifts it;
  - land an executor change without a differential run.
- **Drift between the two.** Every rule now exists in TypeScript and Rust. The vectors and the
  differential runs catch a change on one side, but someone has to port it. The catch-up list
  records what has not been ported, and the scorecard weighs it.
- **Native code in-process.** libvips, libavif and ImageIO run inside the app. sharp and the wasm
  encoder were in utility processes, where a crash on a corrupt file did not take the window down.
  If the fixtures or the owner's use show such crashes, move decoding into a worker process of the
  same binary. That is still not Node.
- **Who keeps GPUI going.** Zed declines GPUI work Zed does not need, and the official crate is a
  year old. Under A, one person at Longbridge owns `gpui-pre` and `gpui-kit` on crates.io. If the
  snapshots stop, pin Zed at the last snapshot's commit (C) and keep the kit at that release.
  Under B, CE rests on three volunteers and a component port that lags. Carry no `[patch]` of
  GPUI; report upstream, and fix locally only behind a pinned fork the plan names.
- **Snapshots break things.** `gpui-pre` follows Zed's `main`, not Zed's releases. Users have hit
  a snapshot that silently turned text rendering off (gpui-kit#3337) and one that needed the
  newest Rust (gpui-kit#3054). Bump only with the GPUI tests and the Phase 0 measurements re-run.
- **API churn.** GPUI can change between snapshots or releases. Exact pins, one bump per PR, and
  the GPUI tests must pass before a bump merges.
- **A moving target.** Electron Oriel gains features weekly: 060, 061 and 062 landed within days.
  Freeze parity at the commit Phase 0 starts. Later features go on the catch-up list, and only
  the scorecard decides whether they are chased.
- **Video.** It is the one thing GPUI does not do. Phase 0 and Phase 8 are the gates, and libmpv
  is the fallback decision.
- **Conversion is slower.** Without WebCodecs, Convert encodes in software through ffmpeg: the
  same archive formats, through the arguments the engine already falls back to. ffmpeg's
  VideoToolbox encoders are a follow-up.
- **Rust in a TypeScript repository.** A second toolchain, a slower build, and reviewers who read
  React. Keep the Rust in one workspace, the formatting in `cargo fmt`, and the lints at clippy's
  defaults plus `-D warnings`.
- **Licences.** GPUI, GPUI Kit and GPUI-CE are Apache-2.0, and Oriel is MIT.
  - libvips is LGPL. It is linked dynamically, as sharp ships it.
  - The ffmpeg builds are the GPL builds Oriel already ships.
  - libmpv, if chosen, needs a check.

## Follow-ups (not in this plan)

- Using Oriel's data, and retiring Electron Oriel, if the owner chooses that in Phase 9. The same
  formats make it a switch.
- Hardware encoders for Convert, through ffmpeg's VideoToolbox and Media Foundation encoders.
- Signing, notarization and auto-update. Velopack has a Rust SDK.
- PDF reading, once plan 040 settles how.
- A `glazier` CLI on `core-tidy`, which plan 058 left as a follow-up.
- Linux, which GPUI supports and nobody here needs yet.

## Sources

- Zed's last `gpui` release, 0.2.2: <https://crates.io/crates/gpui>; its README:
  <https://github.com/zed-industries/zed/blob/main/crates/gpui/README.md>
- Zed's comment closing the custom-shaders PR:
  <https://github.com/zed-industries/zed/pull/42905#issuecomment-3647662949>
- GPUI-CE: <https://github.com/gpui-ce/gpui-ce>, <https://gpui-ce.github.io/>,
  <https://crates.io/crates/gpui-ce>, its AI policy
  <https://github.com/gpui-ce/gpui-ce/blob/main/AI_POLICY.md>. The GPU rendering API, Windows
  surfaces and macOS wgpu renderer: <https://github.com/gpui-ce/gpui-ce/pull/237>,
  <https://github.com/gpui-ce/gpui-ce/pull/121>, <https://github.com/gpui-ce/gpui-ce/pull/287>
- CE's port of GPUI Kit: <https://github.com/gpui-ce/gpui-component>,
  <https://crates.io/crates/gpui_ce_components>
- The request to let GPUI Kit choose CE: <https://github.com/longbridge/gpui-kit/discussions/1856>;
  Longbridge's answer:
  <https://github.com/longbridge/gpui-kit/issues/2234#issuecomment-4210835228>
- GPUI Kit: <https://github.com/longbridge/gpui-kit>, <https://gpui-kit.com>,
  <https://crates.io/crates/gpui-kit>; `gpui-pre`: <https://crates.io/crates/gpui-pre>
- GPUI Fast: <https://github.com/longbridge/gpui-fast>
- What developers say and do about each line:
  [docs/research/gpui-line-sentiment.md](../research/gpui-line-sentiment.md)
- GPUI's image formats and `surface()`: `crates/gpui/src/platform.rs` and
  `crates/gpui/src/elements/surface.rs` in Zed; Zed's per-platform video path:
  `crates/livekit_client/src/remote_video_track_view.rs`
