# Rust GUI toolkits for Oriel RS: iced, Slint, Qt, Dioxus Native and raylib

Research date: 2026-10-27

This note supports D1 in `docs/plans/063-oriel-rs.md`. The owner found these toolkits
recommended on Reddit and asked for each to be checked against Oriel's needs, as fairly as GPUI
was in [the GPUI sentiment note](gpui-line-sentiment.md). Each toolkit is scored on the same
needs:
- a 20,000-tile virtualized gallery;
- video under custom controls (AVPlayer frames on macOS, Media Foundation on Windows);
- desktop chrome and components (a 100k-row table, a tree, menus);
- accessibility, styling, the platforms and testing;
- maturity and licence;
- fit for a port written mostly by agents;
- what developers say about it.

GPUI Kit appears in the table as the baseline.

## Conclusion

None of them beats GPUI Kit for Oriel. Two are real alternatives, each for a different reason.

1. **GPUI Kit stays the best fit.** It is the only option that has most of Oriel's screens
   ready-made:
   - a virtualized, sortable data table, a tree, a sidebar, dialogs and native menus;
   - zero-copy video on macOS (`surface()` takes AVPlayer's `CVPixelBuffer`);
   - AccessKit, headless UI tests and agent skills.

   Its weak points stand: it is pre-1.0 with weekly churn, one person publishes its crates, and
   no Windows video path is zero-copy.
2. **Slint is the strongest pure-Rust alternative.**
   - It is semver-stable since 1.0 (2023), at 1.18.1, run by a funded company, with AccessKit
     on by default, a testing backend and an MCP server for agents.
   - Its licence is not a problem for Oriel. Under GPLv3, binaries handed out are GPL as a whole,
     so their source must be published, which this repository already does. Under the free
     Royalty-free 2.0 licence, Oriel shows Slint's `AboutSlint` widget in an About dialog, or a
     "Made with Slint" badge on the download page.
   - Against it: Oriel would write its own table (Slint's is text-only and single-select), tree,
     toasts and sidebar in Slint's own `.slint` language, and video ends in a GPU copy.
3. **Qt has the best answer to Oriel's hardest problem, but not from Rust yet.**
   - Qt Multimedia is a complete video player with hardware decode on macOS and Windows. Qt Quick
     has `TableView`, `TreeView` and native menus, and its LGPL is easy for an MIT app.
   - But Qt Group's own Qt Bridge for Rust, which is most likely what "qt bridge for rust" means,
     reached Technology Preview only today, with macOS arm64 marked "experimental" and a stable
     release planned for Q1 2027.
   - KDAB's CXX-Qt (0.10) is thinly maintained, and the UI would move into QML, with Qt and a C++
     toolchain in the build.
   - Revisit it when the bridge is stable, or sooner if plan 063's video STOP conditions fire.
4. **iced is capable but misses two things Oriel needs.**
   - It has no accessibility, with the issue open since 2020, so plan 063's VoiceOver step would
     fail.
   - It has no virtualized list or table, and one person wrote 95 of the last 100 commits.
   - It has the best headless tests here, and one wgpu renderer on both platforms.
5. **Freya** (Skia, AccessKit, good tests) is workable, but has no edge over GPUI Kit and rests on
   one maintainer.
6. **Dioxus Native is too early.**
   - It is the only option that could keep much of Oriel's Tailwind CSS.
   - But its Blitz engine is a beta, with no video element, no virtualized list and a GPU image
     cache that never evicts. Its menus and keyboard focus are built by hand, and one engineer
     writes 93% of the engine.
   - Kopuz, a music player with 1.95k stars, tried it three times and then moved to GPUI Kit, as
     its `Cargo.toml` shows.
7. **raylib is a game library, not a UI toolkit.** It has no accessibility, no IME, no text
   shaping, no native menus and no table or tree, and it renders through OpenGL, which Apple has
   deprecated.

**What would change the answer:**
- **Qt.** Qt Bridge for Rust going stable on macOS arm64, or GPUI failing Phase 0's video gate.
  Qt is then the first fallback, because it brings its own player.
- **Slint.** GPUI Kit stalling, or its churn costing more than writing a table and tree in Slint.
- **iced.** iced shipping accessibility.
- **Dioxus Native.** Dioxus 0.8 and Blitz 0.3 going stable, with image eviction, a virtual list
  and a video widget.

## Comparison

| Toolkit | Version, 1.0? | Licence for Oriel | Table, tree, menus | Big virtualized lists | Video, external GPU textures | macOS menu bar, title bar | Accessibility | Headless tests | 90-day downloads; shipped apps | For Oriel |
|---|---|---|---|---|---|---|---|---|---|---|
| **GPUI Kit** (plan 063) | 0.8.1, 2026-10-26; pre-1.0, weekly | Apache-2.0 | Virtualized sortable data table, tree, sidebar, dialogs, native menus | Built in | macOS: `surface()` takes `CVPixelBuffer`, no copy. Windows: a `RenderImage` per frame | Native menu bar; transparent title bar with the traffic-light position | AccessKit | `test-support`, headless | `gpui-kit` 187,625; Longbridge Pro, BongoCat 2.0, Zedis | **Best fit** |
| **Slint** | 1.18.1, 2026-09-21; 1.x since 2023 | GPLv3, or free Royalty-free 2.0 with an About credit or a badge | Text-only, single-select table; no tree; native menu bar and context menus | `ListView` builds only visible rows | wgpu or OpenGL texture import (RGBA8), so one conversion pass; no player | Native menu; transparent title bar through winit and objc2 | AccessKit, on by default | Testing backend, MCP server | `slint` 827,334; LibrePCB 2.0, Koharu | Fit with caveats; strongest pure-Rust alternative |
| **Qt** (Qt Bridge for Rust 0.4, CXX-Qt 0.10, Qt 6.12 LTS) | Bridge: Technology Preview 2026-10-27, stable planned Q1 2027 | LGPLv3 modules; the LGPL bridge crate links statically, which the public source with `Cargo.lock` satisfies | `TableView`, `TreeView`, native `MenuBar` | Delegate pools | Qt Multimedia player with VideoToolbox and D3D11VA; own GPU textures need C++ | Native `MenuBar` (6.8+); title-bar flags (6.9) | Platform accessibility APIs | Qt Quick Test, offscreen | `cxx-qt` 69,176, `qtbridge` 2,895; few Rust apps | Fit with caveats; best video and widgets, young bridges |
| **iced** | 0.14.0, 2025-12-07; no | MIT | Table neither virtual nor sortable; no tree; menus drawn (iced_aw) | None upstream | `shader` widget gets wgpu; we write the zero-copy import; `iced_video_player` copies GStreamer frames | No native menu (`muda` beside it); traffic lights through objc2 | None | `iced_test`: simulator, emulator, snapshots | `iced` 713,061; COSMIC, Kraken Desktop, Sniffnet, Halloy | Fit with caveats; weaker than GPUI Kit |
| **Freya** | 0.4.3; 0.5.0-rc.13; no | MIT | Virtual sortable table, menu; no tree | `VirtualScrollView` | Copies ffmpeg frames | `muda` by hand | AccessKit, IME | `freya-testing` | `freya` 10,945; the maintainer's own | Fit with caveats; no edge |
| **Dioxus Native** | 0.7.10 stable on the 2025 engine; 0.8.0-alpha.3 on Blitz 0.3 beta | MIT or Apache-2.0, plus MPL-2.0 (Stylo) | Only libero, a tiny third-party kit; Blitz has no `<select>` or `<dialog>` | None; the GPU image cache never evicts | No `<video>`; a custom widget can show wgpu textures | `muda` by hand; objc2 | ARIA names; assistive actions are a TODO | Unpublished harness | `dioxus-native` 23,844; none notable | Poor fit today |
| **raylib-rs** | 6.0.0, 2026-06-10 | Zlib | About 25 raygui controls; no table, tree or menus | Immediate mode; we cull | `UpdateTexture` copy per frame | None | None, no IME | Pixel checks | `raylib` 45,261; no desktop apps | Poor fit |

"90-day downloads" is crates.io's `recent_downloads`, read on the research date. Downloads count
CI and dependency fetches, not users.

## Not established

- **Reddit** blocked every request (a login redirect or HTTP 403). The owner's own Reddit reading
  is the only view of it here; two r/rust threads were read through a third-party mirror. Discord,
  Zulip and X need logins.
- **Nothing was built.** Bundle and binary sizes, Slint's video texture path, Qt's AV1 playback on
  macOS and Windows, and large-grid performance on Dioxus Native are inferred from documentation
  and code, not measured. Plan 063's Phase 0 is where such claims get measured.
- **Licences.** The licence readings quote the texts. Two points are flagged for a lawyer:
  whether Slint's Royalty-free 2.0 can be revoked, and what counts as its "public webpage".

## By toolkit

The sections below come from three research passes run in parallel on the research date. Each
has its own sources; reference labels are prefixed `ic-` (iced, raylib), `sq-` (Slint, Qt) and
`dx-` (Dioxus Native, Freya).

## iced

Research date: 2026-10-27. Versions, downloads and commit counts were read on that date from
crates.io's API, with the User-Agent "latch-works-research", and from GitHub through `gh api`. The
90-day window runs from 2026-07-29 to 2026-10-27.

### In one line

A capable, well-tested toolkit in the Elm style, on wgpu, run largely by one person. It would give
Oriel a good renderer and real headless tests, but no virtualized lists, no native menus and no
accessibility.

### What it is

- **Version.** iced 0.14.0, released 2025-12-07 ([release notes][ic-irel]), is still the newest
  `iced` on crates.io; `iced_widget` reached 0.14.2 on 2025-12-11.
  - Master is `0.15.0-dev`, with MSRV 1.93 and wgpu 30 ([Cargo.toml][ic-icargo]).
  - Master pins two forks by git rev: iced-rs's own winit fork and hecrj's fork of cosmic-text.
    0.14.0 used crates.io's winit 0.30, cosmic-text 0.15 and wgpu 27.
  - It is not 1.0. The README says: "Iced is currently experimental software."
- **Cadence and churn.** 0.10 came on 2023-07-28, 0.12 on 2024-02-15, 0.13 on 2024-09-18 and 0.14
  on 2025-12-07: gaps of 7, 7 and 15 months. Every minor release breaks the API.
  - Master already holds more breaks for 0.15. View functions now return `impl Widget`
    ([#3495][ic-i3495]; about 1,400 `.into()` calls dropped), and `Font` generics are gone (#3451).
  - The deprecated `Component` trait was reworked and undeprecated ([#3435][ic-i3435]).
- **Licence.** MIT ([LICENSE][ic-ilic]).
- **Governance and funding.**
  - Héctor Ramón (`hecrj`, Barcelona) created iced and leads it. The `iced-rs` organization shows
    four public members: casperstorm, derezzedex, hecrj and tarkah.
  - The README says development "is sponsored by the Cryptowatch team at Kraken.com". hecrj also has
    13 GitHub sponsors and a Ko-fi.
  - The book's philosophy page: "iced is just my personal project. I work on it on my own terms, on
    my time", and "I do not hesitate to introduce breaking changes." ([philosophy][ic-iphil])
  - CONTRIBUTING.md: "The core team is busy and does not have time to mentor nor babysit new
    contributors."
- **Bus factor: one.** hecrj wrote 275 of the 300 non-merge commits on master in the 90-day window
  (92%), and 19 of its 40 merged PRs.
- **libcosmic**, iced's largest user, is System76's toolkit for the COSMIC desktop.
  - It is built on System76's fork of iced (`pop-os/iced`, at 0.14.0). The fork adds a virtual
    `List` widget and an AccessKit integration.
  - Its licence is MPL-2.0. Its Cargo.toml says 1.0.0, but it is not on crates.io: it is a git
    dependency, with the iced fork as a submodule.
  - It targets COSMIC on Linux. macOS and Windows builds exist, with open bugs
    ([#765][ic-c765], [#766][ic-c766], [#1152][ic-c1152]: "Windows build brocken in Main branch").
  - System76 bans LLM output: "Content generated by any LLM (also known as AI) may not be
    contributed in issues or PRs to Pop!_OS projects" ([policy][ic-popai]).

### Oriel's needs

Support: **Yes**; **Partial**, meaning it works with our own code; **Build**, meaning we write it;
**No**.

| Need | Support | Evidence |
|---|---|---|
| 1. 20k-tile gallery | Partial: RGBA in, GPU cache; no virtual grid | [cache][ic-ir], [#160][ic-i160] |
| 2. Video under our controls | Partial: `shader` gets wgpu; no zero-copy crate | [trait][ic-iprim] |
| 3. Desktop chrome | Partial: no native menu; title bar flags; drops in | [#2931][ic-i2931] |
| 4. Components | Partial: basics built in; table not virtual; no tree | [table][ic-itab] |
| 5. A11y, IME, text | No a11y upstream; IME since 0.14; cosmic-text | [#3281][ic-i3281] |
| 6. House styling | Yes: radius, border, shadow, palette, system theme | [0.14][ic-irel] |
| 7. macOS arm64, Windows x64 | Yes: wgpu on Metal and DX12; shipped on both | [Kraken][ic-kraken] |
| 8. Headless tests | Yes: simulator, emulator, `.ice` files, snapshots | [iced_test][ic-itest] |
| 9. Maturity | Partial: 0.14, a break a year, bus factor one | [philosophy][ic-iphil] |
| 10. Licence | Yes: MIT; libcosmic MPL-2.0; GStreamer LGPL | [LICENSE][ic-ilic] |
| 11. Agent-written port | Partial: many examples, thin book, churn | [book][ic-ibook] |
| 12. Sentiment | Mixed: architecture praised; widgets, docs, a11y not | Sentiment |

Notes on each need:

1. **Gallery.**
   - **Taking images.** `image::Handle::from_rgba(width, height, pixels)` takes decoded RGBA;
     `from_path` and `from_bytes` decode through the `image` crate ([image.rs][ic-iimg]).
   - **The GPU cache.** `iced_wgpu` keeps uploads in a texture atlas. Its cache `trim` drops every
     image that was not drawn since the last trim, unless the app holds an `image::Allocation`
     ([raster.rs][ic-ir]).
     - Eviction is therefore automatic. The app pins its prefetch window by holding allocations
       from the `image::allocate` task, new in 0.14 (#3092).
     - Images over 2 MiB upload on a worker and appear a frame or more later.
   - **No virtualized list or grid upstream.**
     - `grid`, `column` and `row` build and lay out every child. `column` and `row` skip drawing
       off-screen children only (#2611).
     - An `InfiniteList` request has been open since 2020 ([#160][ic-i160]). hecrj's
       `feature/list-widget-reloaded` branch was last touched 2024-05-18. libcosmic's fork carries
       that `List`, which re-measures every row on a horizontal resize ([#3429][ic-i3429]).
     - hecrj's reply in #3429, 2026-08-17: "Sir, I'm afraid we don't have a `list` widget."
     - The known workaround is a custom widget that draws only the visible rows. That is how
       users reached 10k rows in [#1720][ic-i1720], and fastfiler reports 100k rows at 60 fps (see
       Sentiment).
   - **The `gallery` example** lazy-loads with `sensor` and `image::allocate` ([gallery][ic-igal]),
     but it is not virtualized.
2. **Video.** See the next section.
3. **Desktop chrome.**
   - **Native menu bar: none.** hecrj, 2025-05-09, closing a `muda` PR: "The GTK dependencies on
     Linux are a big price to pay just for system menus. I'd like to try drawing the menus
     ourselves first." ([#2931][ic-i2931]) An independent user runs `muda` beside iced on macOS in
     karolisr/treehouse. iced_aw draws a menu bar.
   - **Title bar.** macOS `PlatformSpecific` has `title_hidden`, `titlebar_transparent` and
     `fullsize_content_view` ([macos.rs][ic-imac]). Insetting the traffic lights is not in winit, so
     it needs objc2 on the `NSWindow`, reached through `window::run` (0.14, #2718).
   - **File dialogs** come from `rfd`, which iced's workspace and `editor` example use.
   - **External drops.** `window::Event::FileHovered` and `FileDropped(PathBuf)`
     ([event.rs][ic-ievt]) cover drops in. There is no drag out.
   - **Context menus and tooltips.** No context menus are built in; iced_aw has `ContextMenu`, and
     `muda` can show native ones. `tooltip` is built in, with a delay since 0.14.
   - **Keyboard and focus.** Shortcuts come from keyboard subscriptions. Only `text_input`,
     `text_editor` and `combo_box` take focus, so buttons cannot, and Tab order is the app's job
     ([#489][ic-i489], open since 2020).
   - **Dock badge and progress** need objc2.
4. **Components.**
   - **Built in:** button, checkbox, radio, toggler, slider, vertical slider, `pick_list`,
     `combo_box`, `text_input`, `text_editor`, `scrollable` (smooth scrolling on master, #3479),
     `pane_grid`, `grid`, `tooltip`, `markdown`, `stack`, `float`, `pin`, `sensor`, and `sticky`
     on master.
   - **`table`** (0.14) turns every cell into an element. It has no virtualization, sorting or
     selection ([table.rs][ic-itab]).
   - **Only in examples:** `modal` and `toast`.
   - **iced_aw** ([repo][ic-aw]) adds Menu, ContextMenu, Sidebar, TabBar and Tabs, Card, Badge,
     NumberInput, SelectionList, DropDown, and colour, date and time pickers. It tracks iced
     closely: 0.13.0 came the day after iced 0.14.
   - **libcosmic** adds a `table` with sorting and single or multiple selection, `nav_bar`,
     `dialog`, `context_drawer`, `toaster`, `menu` and `settings`. They exist only on its fork.
   - **We would write:** the virtual gallery grid, the 100k-row table, the tree, the sheets and
     the toasts.
5. **Accessibility, IME and text.**
   - **Accessibility: none upstream.**
     - Issue [#552][ic-i552] has been open since 2020. Draft [#3111][ic-i3111] covers Button and Text
       only.
     - [#3281][ic-i3281], a full AccessKit PR, was closed by hecrj on 2026-03-14: "Thanks! But I'll
       work on this myself." No date was given.
     - libcosmic's fork has AccessKit behind an `a11y` feature, but its `text_input` "contributes
       nothing to the accessibility tree" ([#1429][ic-c1429], 2026-09-10).
   - **IME:** since 0.14 ([#2777][ic-i2777]). Open bugs include Windows Japanese conversion
     ([#3189][ic-i3189]).
   - **Text:** cosmic-text shaping with swash rasterization, not CoreText. Selectable `text` is on
     master only ([#3497][ic-i3497]).
6. **Styling.**
   - Each widget takes a style closure returning a `Style` with `Background`,
     `Border { radius, width, color }` and `Shadow { color, offset, blur_radius }`. 0.14 moved quads
     to one SDF shader (#2967).
   - Custom themes come from a `Palette`, with Oklch generation in 0.14 (#3028), and follow the
     system theme (#3051). One accent colour is `palette.primary`.
7. **Platforms.** wgpu runs on Metal on macOS and on DX12 or Vulkan on Windows, with tiny-skia as a
   software fallback. Kraken Desktop ships on Windows, macOS and Linux ([Kraken][ic-kraken]), and
   Halloy publishes macOS and Windows builds.
8. **Testing** ([lib.rs][ic-itest]).
   - `iced_test::simulator` drives a view headlessly: `click`, `typewrite`, `find` by text or id,
     and `snapshot`.
   - `Emulator` runs the real program from `.ice` files, which the `tester` feature records
     (#3059).
   - This is the strongest part of iced for Oriel's parity list.
9. **Maturity:** see What it is and Adoption.
10. **Licence.**
    - iced, iced_aw and `muda` are MIT or Apache-2.0, which fits an MIT app.
    - libcosmic is MPL-2.0, which is file-level copyleft: also fine for an app distributed as
      source, but changed MPL files stay MPL.
    - iced_video_player is MIT or Apache-2.0, but it links GStreamer, which is LGPL.
11. **Agent fit:** see Fit for an agent-written port.
12. **Sentiment:** see Sentiment.

### Video and custom GPU content

iced has no video widget. There are three paths to video under drawn controls.

1. **A new `image::Handle` per frame.** This re-uploads every frame, and it is broken for frames
   over 2 MiB, about 725×725 RGBA. Those upload on a worker, and a new handle every frame
   supersedes each upload before it lands. The result is "flickering or the image never rendering
   at all" ([#3381][ic-i3381], open, 2026-07-06).
   - It is reported independently with FFmpeg on 0.14 ([#3177][ic-i3177], #3190).
   - The workaround suggested on 2026-10-26 is holding `image::Allocation`s, with the caveat that
     "using a `widget::Image` for a constantly updating display doesn't seem very efficient."
   - This is not a video path.
2. **The `shader` widget, copying planes.** `Pipeline::new(device, queue, format)` and
   `Primitive::prepare` hand custom code the app's own `wgpu::Device` and `Queue`
   ([primitive.rs][ic-iprim]). iced_video_player does this ([repo][ic-ivp]).
   - **Pipeline.** GStreamer's `playbin` runs into `videoconvert`, then an `appsink` with
     `caps=video/x-raw,format=NV12` in CPU memory.
   - **Per frame**, `queue.write_texture` fills an `R8Unorm` and an `Rg8Unorm` texture, and WGSL
     converts YUV to RGB. That is a copy every frame, but of 1.5 bytes per pixel.
   - **Status.** 0.6.0 came out on 2025-12-14. It has 206 stars, 18,439 downloads and 3 reverse
     dependencies.
   - **Open issues:** a leak unless the `Video` is dropped by hand (#14), and "Add ffmpeg backend"
     (#37).
   - The README says "GStreamer is a bit annoying to set up on Windows." Madamiru, a multi-video
     player, uses it as an optional feature.
   - With AVPlayer, Oriel would copy `CVPixelBuffer` planes the same way.
3. **The `shader` widget, importing without copies.** The chain on macOS:
   - `AVPlayerItemVideoOutput` gives a `CVPixelBuffer`;
   - `CVMetalTextureCache` turns it into an `MTLTexture`;
   - wgpu-hal's Metal `texture_from_raw` and `create_texture_from_hal` wrap that as a
     `wgpu::Texture`, which a primitive draws.

   Vello's `wgpu_video` example does exactly this on plain wgpu ([metal_import.rs][ic-vello]), and
   LiveKit's Rust SDK does it under egui ([subscriber.rs][ic-lk]). No iced crate does. We would own it,
   wgpu-hal is `unsafe`, and its API moves with each wgpu major: 27 in iced 0.14, 30 on master.

**Windows.** iced renders through wgpu on DX12 there too, so path 3 has the same shape: Media
Foundation D3D11 textures shared into D3D12 and wrapped through wgpu-hal. Path 2 works unchanged.
No iced project was found doing path 3 on Windows. By contrast, plan 063 notes that Zed's DirectX
`draw_surfaces` is a no-op.

**Controls over video** are ordinary widgets in a `stack` above the shader widget. iced_video_player
once had tooltips that did not show during playback (#31, closed).

### Adoption and activity

| Crate | Latest | Downloads | 90-day | Rev. deps | Stars |
|---|---|---|---|---|---|
| `iced` | 0.14.0, 2025-12-07 | 3,122,651 | 713,061 | 410 | 31,845 |
| `iced_aw` | 0.14.1, 2026-04-27 | 578,041 | 103,966 | 39 | 691 |
| `iced_test` | 0.14.0, 2025-12-07 | 73,194 | 54,437 | 22 | (in iced) |
| `iced_video_player` | 0.6.0, 2025-12-14 | 18,439 | 5,043 | 3 | 206 |
| libcosmic | git only, "1.0.0" | n/a | n/a | n/a | 961 |

"90-day" is crates.io's `recent_downloads`.

**Activity in the 90-day window:**
- iced master: 339 commits from 13 authors, 39 of them merges, and 40 merged PRs.
- libcosmic: 104 commits from 16 authors.
- `pop-os/iced`: 30 commits.

**Shipped desktop apps:**
- the COSMIC desktop, in Pop!_OS 24.04 LTS on 2025-12-11 ([System76][ic-s76]);
- Kraken Desktop: Kraken says the app was developed "from scratch using Iced" (2024-10-31,
  [blog][ic-kraken]);
- Sniffnet (41.7k stars), on iced 0.14.0 from crates.io;
- Halloy (4.6k stars), which runs on a fork of iced's master (`squidowl/iced`, 0.15.0-dev);
- Madamiru, a multi-video player using iced_video_player.

iced's showcase lists these and more ([iced.rs][ic-ihome]).

### Sentiment

**Sample.** Hacker News comments from 2024-12-01 to 2026-10-27, for "iced gui", "iced rust",
"iced gpui", "iced elm", "iced egui", "iced slint", "gpui iced" and "libcosmic": 154 unique
comments. Added to those: 20 Lobsters comments, 2 survey blogs and GitHub migration PRs.

**Not reached.** Reddit's `old.reddit.com` JSON redirected to a login page, and `api.reddit.com`
and `www.reddit.com` returned HTTP 403 ("You've been blocked by network security"). Discord and
Zulip need logins.

**Counts.** About 46 distinct independent people gave a judgement:
- 12 favourable;
- 6 mixed;
- 16 unfavourable: 13 in words, and 3 who moved projects to GPUI.

The critics' themes were documentation (5), accessibility (4), missing widgets or virtual lists
(4), governance and the maintainer's style (3), and churn and release cadence (3).

**Comparisons with GPUI or GPUI Kit.** 5 favour GPUI Kit (IshKebab, hoistbypetard and the three
movers) and 2 favour iced (the two who moved from GPUI). Every switcher found has a small
project.

**Quotes.** HN items are at `news.ycombinator.com/item?id=`.

- **hecrj, maintainer**, 2026-03-14, declining an AccessKit PR: "Thanks! But I'll work on this
  myself." ([#3281][ic-i3281])
- **IshKebab, independent**, 2026-02-13, needing a table with a million rows. They called
  gpui-component "Definitely the best option today"; of iced: "looks nice and seemed to work fairly
  well. No virtualised lists though." ([47003586][ic-hn1])
- **lazypenguin, independent**, 2025-12-07: "the Rust community is sleeping on the potential of
  iced for traditional desktop gui." ([46185947][ic-hn2]) Two months later: "iced for a nice
  architecture but you have to roll all your own widgets." ([47004883][ic-hn3])
- **chironjit, independent**, 2025-12-08: "LLMs are not as familiar with Iced's styling, and will
  struggle … plus also dealing with the breaking changes between Iced versions."
  ([46187820][ic-hn4])
- **neonstatic, independent**, 2026-06-13: "very performant … Lots of changes between releases …
  layouting engine is tricky." ([48517068][ic-hn5])
- **thorn132, independent**, 2025-12-08: "My iced apps startup much faster than the Qt(Pyside) and
  Electron apps they replaced." ([46194567][ic-hn6])
- **artursapek**, who worked at Kraken, the sponsor, 2025-10-27: "My team at Kraken worked on
  iced … It can maintain high frame rates." ([45720890][ic-hn7])
- **olebedev, independent**, 2025-04-13: the maintainer "doesn't bother to be involved in
  discussions in their discord and merge behemoth size changes with no review"
  ([43669118][ic-hn8]).
- **ClawsOnPaws, independent screen-reader user**, 2025-10-15, on Halloy: "it seems to not be
  accessible with screen readers." ([45596947][ic-hn9])
- **osa1, independent**, 2025-06-27, on Linux: iced apps "all seem 'laggy'" ([44397472][ic-hn10]).
- **flashfilter, independent**, 2026-07-20. They moved from GPUI to iced 0.14; GPUI "made the app
  significantly more complex and was giving us problem[s] with our build pipeline."
  ([48982323][ic-hn11])
- **white-star, independent**, Lobsters, 2026-08-22: "libcosmic and iced … Both project's books
  end on the third substantial page." ([Lobsters][ic-lob])
- **Wybxc, independent blog**, 2026-08, on iced: "IME works fine, but the screen reader cannot
  recognize the content." GPUI Component made their shortlist and iced fell just short.
  ([survey][ic-wyb])
- **Switchers.**
  - From iced to GPUI: ProjMan (2026-08-09, "I much prefer this architecture over the Elm
    architecture", [PR][ic-projman]), muxtrix (2026-08-23, [PR][ic-mux]) and lapiz (2026-05-31,
    [PR][ic-lapiz]).
  - From GPUI to iced: fastfiler, a Windows file manager, in an ADR dated 2026-07-04 ([ADR][ic-ff],
    in Japanese; translations are mine). Its reasons, all from before `gpui-pre`:
    - GPUI was vendored from Zed's repository with a `[patch.crates-io]`, which locked the
      toolchain and edition and made clean builds take minutes;
    - the licence of the vendored code was unclear;
    - state was scattered across global statics, so unit tests were "almost impossible (0
      tests)".
  - After the move, fastfiler has 79 tests. Its list, tree, tabs and menus are custom-drawn
    widgets, and a Phase 0 spike measured a virtual list at 100,000 rows and 60 fps. Windows
    external drag-and-drop runs through its own OLE `RegisterDragDrop` beside iced.

### Fit for an agent-written port

- **Documentation.**
  - The API docs on docs.rs are thorough, and the repository has about 50 examples, including
    `gallery`, `table`, `modal`, `toast`, `custom_shader`, `custom_widget` and `multi_window`.
  - The book has three "Learning the Basics" chapters and two widget pages, then "More to come!"
    ([book][ic-ibook]).
  - There is no AGENTS.md, no agent guidance and no `llms.txt`: `iced.rs/llms.txt` returns 404.
- **AI stance.**
  - iced has no written policy. hecrj ported smooth scrolling from Chromium "using Qwen 3.8"
    ([#3479][ic-i3479]) and merged a PR marked "Generated with Claude Code" ([#3442][ic-i3442]).
  - System76's cosmic-text requires that a PR has no LLM-generated content. When hecrj's
    text-selection work needed cosmic-text changes, its maintainer jackpot51 wrote: "I'm okay if you
    fork cosmic-text, rename it, and go about your day. The LLM policy won't change."
    ([comment][ic-ct]) Master now pins hecrj's fork.
  - Agent-written fixes are acceptable to iced in practice, and not to anything from System76.
- **Architecture against Oriel's React.**
  - iced is the Elm architecture: one state tree, a `Message` enum, `update` and `view`. React's
    component-local state and hooks must be lifted into app state, or written as a `Component`,
    which is undeprecated only on master.
  - Effects become `Task`s and `Subscription`s. That maps cleanly onto Oriel's engines, which are
    already separate from the UI, but it means rewriting every React component's state, not
    translating it.
  - lazypenguin calls the architecture iced's strength; ProjMan's author left iced over it.
- **Churn and model knowledge.** Each minor release changes the API (0.13 moved styling to
  closures; 0.15 changes view types), so models trained on older code write stale iced. Pin
  0.14.0, or pin a master rev for selectable text, and expect one migration PR per release.

### Verdict for Oriel

**Fit with caveats, and a weaker fit for Oriel than GPUI Kit.**

- **For it:** an MIT engine with real shipped apps (Kraken Desktop, COSMIC, Sniffnet); the best
  headless and recorded UI tests among the options here; one wgpu renderer on macOS and Windows,
  which makes Windows video simpler than under GPUI.
- **Against it:** Oriel would write its own virtual gallery grid, 100k-row table, tree, toasts and
  sheets, and would add the native menu through `muda`.
- **The hard caveats:** no accessibility upstream and no date for it; a bus factor of one; and a
  breaking release about once a year.

What choosing it would change in plan 063, compared with GPUI Kit:

- **Phase 0.1.**
  - Scaffold on `iced` 0.14.0, plus `muda` for the native menu and objc2 for the traffic-light
    inset and the Dock. Pinning master instead brings its git forks of winit and cosmic-text.
  - Make the house theme a custom `Theme` and `Palette`, with style closures.
- **Phase 0.3.**
  - Replace `uniform_list` with our own virtual grid widget. Pin the visible range and the prefetch
    window with `image::allocate`.
  - Write the 100k-row table, since GPUI Kit's table has no counterpart. Measure frame time with
    iced's `debug` metrics instead of GPUI's profiler and `gpui-fps`.
- **Video (Phase 0 and Phase 8).**
  - Replace `gpui::surface()` with our own `shader` primitive: `CVPixelBuffer` through
    `CVMetalTextureCache` and wgpu-hal, with NV12 plane uploads as the fallback.
  - Phase 8 then applies the same primitive to DX12 and Media Foundation. Its three-way
    measurement becomes "import or copy".
- **Phase 1.3.** Background work moves to `Task`s and a tokio executor, instead of GPUI's executor.
- **Phase 2.**
  - Replace `cx.set_menus` with a `muda` menu per mode.
  - Step 6, VoiceOver, cannot pass on upstream iced. It needs either the owner's waiver or a
    vendored AccessKit integration: libcosmic's, which is MPL-2.0 and partial, or the julep-iced
    diff linked from #3281.
- **Verification.** The parity cases become `iced_test` simulator and emulator tests, with `.ice`
  files and snapshots, instead of GPUI Kit's `test-support`.
- **Risks.** "Who keeps GPUI going" becomes "who keeps iced going": one maintainer, a crates.io
  release about once a year, and master on git forks.

### Sources

- iced repository, README, CONTRIBUTING.md, ROADMAP.md and Cargo.toml:
  <https://github.com/iced-rs/iced>
- Release 0.14.0: <https://github.com/iced-rs/iced/releases/tag/0.14.0>
- crates.io API: <https://crates.io/api/v1/crates/iced> (also `iced_aw`, `iced_test`,
  `iced_video_player` and `/reverse_dependencies`)
- Book and philosophy page: <https://book.iced.rs/>, <https://book.iced.rs/philosophy.html>
- Image cache: <https://github.com/iced-rs/iced/blob/master/wgpu/src/image/raster.rs>;
  `Handle` and `Allocation`: <https://github.com/iced-rs/iced/blob/master/core/src/image.rs>
- `shader` primitive: <https://github.com/iced-rs/iced/blob/master/wgpu/src/primitive.rs>
- Issues and PRs: <https://github.com/iced-rs/iced/issues/160>, `/issues/489`, `/issues/552`,
  `/issues/1720`, `/issues/3381`, `/issues/3429`, `/pull/2931`, `/pull/3111`, `/pull/3281`,
  `/pull/3435`, `/pull/3479`, `/pull/3495`, `/pull/3497` (all under iced-rs/iced)
- iced_video_player: <https://github.com/jazzfool/iced_video_player>
- iced_aw: <https://github.com/iced-rs/iced_aw>
- libcosmic: <https://github.com/pop-os/libcosmic>; its iced fork: <https://github.com/pop-os/iced>;
  System76's AI rule: <https://github.com/pop-os/pop/blob/master/CONTRIBUTING.md>
- Zero-copy references: Vello's `wgpu_video` example, file `src/video/metal_import.rs` in
  <https://github.com/linebender/vello/tree/main/vello_gpu/examples/wgpu_video>, and LiveKit's
  <https://github.com/livekit/rust-sdks/blob/main/examples/local_video/src/subscriber.rs>
- Kraken Desktop: <https://blog.kraken.com/product/kraken-desktop>
- COSMIC Epoch 1 and Pop!_OS 24.04:
  <https://system76.com/blog/post/pop-os-letter-from-our-founder>
- Sentiment: the HN items, Lobsters, blog and PRs linked in Sentiment.

[ic-irel]: https://github.com/iced-rs/iced/releases/tag/0.14.0
[ic-icargo]: https://github.com/iced-rs/iced/blob/master/Cargo.toml
[ic-ilic]: https://github.com/iced-rs/iced/blob/master/LICENSE
[ic-iphil]: https://book.iced.rs/philosophy.html
[ic-ibook]: https://book.iced.rs/
[ic-ihome]: https://iced.rs/
[ic-ir]: https://github.com/iced-rs/iced/blob/master/wgpu/src/image/raster.rs
[ic-iimg]: https://github.com/iced-rs/iced/blob/master/core/src/image.rs
[ic-igal]: https://github.com/iced-rs/iced/tree/master/examples/gallery
[ic-iprim]: https://github.com/iced-rs/iced/blob/master/wgpu/src/primitive.rs
[ic-imac]: https://github.com/iced-rs/iced/blob/0.14.0/core/src/window/settings/macos.rs
[ic-ievt]: https://github.com/iced-rs/iced/blob/master/core/src/window/event.rs
[ic-itab]: https://github.com/iced-rs/iced/blob/master/widget/src/table.rs
[ic-itest]: https://github.com/iced-rs/iced/blob/0.14.0/test/src/lib.rs
[ic-i160]: https://github.com/iced-rs/iced/issues/160
[ic-i489]: https://github.com/iced-rs/iced/issues/489
[ic-i552]: https://github.com/iced-rs/iced/issues/552
[ic-i1720]: https://github.com/iced-rs/iced/issues/1720
[ic-i3177]: https://github.com/iced-rs/iced/issues/3177
[ic-i3189]: https://github.com/iced-rs/iced/issues/3189
[ic-i3381]: https://github.com/iced-rs/iced/issues/3381
[ic-i3429]: https://github.com/iced-rs/iced/issues/3429
[ic-i2777]: https://github.com/iced-rs/iced/pull/2777
[ic-i2931]: https://github.com/iced-rs/iced/pull/2931
[ic-i3111]: https://github.com/iced-rs/iced/pull/3111
[ic-i3281]: https://github.com/iced-rs/iced/pull/3281
[ic-i3435]: https://github.com/iced-rs/iced/pull/3435
[ic-i3442]: https://github.com/iced-rs/iced/pull/3442
[ic-i3479]: https://github.com/iced-rs/iced/pull/3479
[ic-i3495]: https://github.com/iced-rs/iced/pull/3495
[ic-i3497]: https://github.com/iced-rs/iced/pull/3497
[ic-ct]: https://github.com/iced-rs/iced/pull/3497#issuecomment-5952223620
[ic-aw]: https://github.com/iced-rs/iced_aw
[ic-ivp]: https://github.com/jazzfool/iced_video_player
[ic-c765]: https://github.com/pop-os/libcosmic/issues/765
[ic-c766]: https://github.com/pop-os/libcosmic/issues/766
[ic-c1152]: https://github.com/pop-os/libcosmic/issues/1152
[ic-c1429]: https://github.com/pop-os/libcosmic/issues/1429
[ic-popai]: https://github.com/pop-os/pop/blob/master/CONTRIBUTING.md
[ic-vello]: https://github.com/linebender/vello/tree/main/vello_gpu/examples/wgpu_video
[ic-lk]: https://github.com/livekit/rust-sdks/blob/main/examples/local_video/src/subscriber.rs
[ic-kraken]: https://blog.kraken.com/product/kraken-desktop
[ic-s76]: https://system76.com/blog/post/pop-os-letter-from-our-founder
[ic-hn1]: https://news.ycombinator.com/item?id=47003586
[ic-hn2]: https://news.ycombinator.com/item?id=46185947
[ic-hn3]: https://news.ycombinator.com/item?id=47004883
[ic-hn4]: https://news.ycombinator.com/item?id=46187820
[ic-hn5]: https://news.ycombinator.com/item?id=48517068
[ic-hn6]: https://news.ycombinator.com/item?id=46194567
[ic-hn7]: https://news.ycombinator.com/item?id=45720890
[ic-hn8]: https://news.ycombinator.com/item?id=43669118
[ic-hn9]: https://news.ycombinator.com/item?id=45596947
[ic-hn10]: https://news.ycombinator.com/item?id=44397472
[ic-hn11]: https://news.ycombinator.com/item?id=48982323
[ic-lob]: https://lobste.rs/c/krer4i
[ic-wyb]: https://blog.wybxc.cc/blog/rust-gui-survey-2026/
[ic-projman]: https://github.com/CultOfTheBlob/ProjMan/pull/3
[ic-mux]: https://github.com/Phoenixmatrix/muxtrix/pull/73
[ic-lapiz]: https://github.com/lapiz-rs/lapiz/pull/14
[ic-ff]: https://github.com/omizu555/fastfiler/blob/main/doc/adr/0013-migrate-gpui-to-iced.md

## raylib (Rust bindings)

### In one line

A good small library for games, but the wrong foundation for Oriel. raylib-rs plus raygui gives a
game loop, textures and about 25 basic immediate-mode controls. It has no native menus, no
accessibility, no IME, no text shaping and no table or tree, so Oriel would be writing a UI
toolkit.

### What it is

- **Version.** The `raylib` and `raylib-sys` crates are at 6.0.0, published 2026-06-10, and bind
  raylib 6.0 ([crate][ic-rlcrate]). Upstream C raylib reached 6.2 on 2026-10-15 ([6.2][ic-rl62]).
  - The README calls 6.0 "a near-complete rework of the binding" ([README][ic-rlreadme]).
  - raylib-rs uses raylib's version numbers. raylib's own C library is past 6.0 and makes no 1.0
    distinction.
- **Cadence.** Binding releases follow C releases at a lag:
  - 5.0.0 on 2024-05-19, 5.5.0 on 2025-03-21 and 6.0.0 on 2026-06-10;
  - the C library's 6.0 came out on 2026-04-23.
- **Licence.** Zlib, for raylib-rs, raylib and raygui ([LICENSE.md][ic-rllic]).
- **Governance.**
  - raylib-rs is a community organization. Its crates.io owners are deltaphc (the original
    author), Dacode45, IoIxD and bitten2up.
  - Dacode45 wrote 40 of the 45 commits in 2026.
  - On 2026-04-24 a user forked the project as `sola-raylib` (6.3.1; 4,279 downloads), citing
    "many unreleased versions on crates.io, lingering PRs, 5 months since last commit"
    ([#294][ic-rl294]).
  - C raylib is led by Ramon Santamaria (raysan5), who says the focus "is simplicity … it's not
    the objective for raylib to become a full-featured engine" ([FAQ][ic-rlfaq]).

### Oriel's needs

| Need | Support | Evidence |
|---|---|---|
| 1. 20k-tile gallery | Build: RGBA textures; we cull, cache and evict | [raylib.h][ic-rlh] |
| 2. Video under our controls | Build: `UpdateTexture` per frame; OpenGL only | [raylib.h][ic-rlh] |
| 3. Desktop chrome | No: no menus or dialogs; drops in; flags only | [raylib.h][ic-rlh] |
| 4. Components | No: about 25 raygui controls; no table or tree | [raygui][ic-rg] |
| 5. A11y, IME, text | No: no a11y; IME PR closed; no shaping | [#2809][ic-rlime] |
| 6. House styling | Build: flat raygui styles; we draw shadows | [raygui][ic-rg] |
| 7. macOS arm64, Windows x64 | Partial: GLFW and OpenGL 3.3, deprecated on macOS | [FAQ][ic-rlfaq] |
| 8. Headless tests | Partial: software renderer, pixel probes | [README][ic-rlreadme] |
| 9. Maturity | Partial: 6.0.0 trails C 6.2; one main maintainer | [#294][ic-rl294] |
| 10. Licence | Yes: Zlib | [LICENSE.md][ic-rllic] |
| 11. Agent-written port | Partial: CLAUDE.md, book, 229 examples; no UI model | [docs][ic-rlclaude] |
| 12. Sentiment | Games only; no desktop-app users found | Sentiment |

Notes:

1. **Gallery.**
   - Raw RGBA becomes an `Image`, then a `Texture2D` (`LoadTextureFromImage`), freed on drop.
   - Immediate mode makes virtualization trivial, since we draw only the visible tiles. But the
     cache, eviction, scrolling physics and layout are all ours.
2. **Video.** See below.
3. **Chrome.**
   - There is no menu bar, no file dialog and no context menu: we would add `muda`, `rfd` and our
     own.
   - Drops in: `IsFileDropped` and `LoadDroppedFiles`.
   - The window has only GLFW flags (`FLAG_WINDOW_UNDECORATED`, `FLAG_WINDOW_TRANSPARENT`), so the
     title bar and the traffic lights need objc2 through `GetWindowHandle`.
   - raygui has tooltips (`GuiSetTooltip`), and its only focus control is a global lock.
4. **Components** ([raygui.h][ic-rgh]).
   - raygui has Label, Button, Toggle, CheckBox, ComboBox, DropdownBox, TextBox, ValueBox, Spinner,
     Slider, ProgressBar, ListView, TabBar, ScrollPanel, WindowBox, MessageBox, TextInputBox and
     ColorPicker.
   - Its README calls itself "intended for tools development".
5. **Accessibility, IME and text.**
   - Accessibility: none.
   - IME: raysan5 closed the IME PR on 2026-01-12: "GLFW does not seem to still support it easely,
     there is neither an easy implementation for raylib and not supported in too many target
     platforms" ([#2809][ic-rlime]).
   - Text: fonts are rasterized by stb_truetype into an atlas at the size given to `LoadFontEx`
     ([rtext.c][ic-rltext]), with no shaping and no fallback fonts.
6. **Styling.** raygui styles are flat property sets. `DrawRectangleRounded` exists; soft shadows
   and rings are shaders we would write.
7. **Platforms.** raylib "is built on top of OpenGL API, and there are currently no plans to support
   any other graphics APIs" ([FAQ][ic-rlfaq]). Apple deprecated OpenGL in macOS 10.14. Windows is fine
   through GLFW; the new Win32 backend is marked experimental ([6.0][ic-rl60]).
8. **Testing.** The `software_renderer` feature and `raylib::test_harness` (`with_headless`,
   `pixel_at`, `assert_pixel`) run in CI on all three desktop OSes. They assert pixels, not
   widgets.

### Video and custom GPU content

raylib decodes no video.
- **Copying.** The simple path re-uploads each frame with `UpdateTexture`.
- **Without copies.** The only route is `unsafe` raylib-sys: build a `Texture2D` around an OpenGL
  texture id filled from the frame's IOSurface through CGL. That rides on Apple's deprecated
  OpenGL.
- **Windows.** The equivalent needs WGL interop with Media Foundation's D3D textures.
- **Controls.** Drawing them over video is easy in immediate mode.
- **Existing work.** No video widget or crate for raylib-rs was found.

### Adoption and activity

| Measure | raylib-rs (`raylib`) |
|---|---|
| Latest | 6.0.0, 2026-06-10 (binds C 6.0; C is at 6.2) |
| Downloads, total and 90-day | 323,256 and 45,261 |
| Reverse dependencies | 39, almost all games and demos |
| Stars | 351 (raylib-rs); C raylib 35,445; raygui 5,238 |
| 90-day commits | 5 commits from 5 authors on `unstable` |
| Shipped desktop apps | None found in Rust; raysan5's raylibtech tools are in C |

### Sentiment

Hacker News (Algolia) returned no comments and no stories for "raylib-rs". Lobsters had no raylib
comments that mention Rust. Reddit was blocked, as above. Every user found was writing a game, and
nobody was found using raylib-rs for a desktop app.

- **brettchalupa, independent**, 2026-04-24: "Due to raylib-rs being seemingly dormant … I've
  forked it." ([#294][ic-rl294])
- **Dacode45, maintainer**, 2026-06-09: "raylib 6.0 support has landed … the crates.io publish is
  the remaining release step." ([#294][ic-rl294])
- **999900000999, independent**, 2025-06-13: "I like Raylib, but it's just a rendering system."
  ([44271435][ic-rhn1])
- **phqb, independent**, 2026-07-15, on a Rust raylib game: "considering migrating to bevy to not
  have to implement (good) shadow, lighting … from scratch." ([48915956][ic-rhn2])
- **Daryl, independent**, 2026-08-20, on an M2 Mac: a build failure on `GLFW_SCALE_FRAMEBUFFER`
  with Rust and raylib ([forum][ic-rforum]).

### Fit for an agent-written port

- **Documentation is the binding's strength.** Since 6.0 the repository has a CLAUDE.md, a
  28-chapter mdBook, 229 ported examples and strict CI ([README][ic-rlreadme],
  [CLAUDE.md][ic-rlclaude]). The 6.0 rework was itself planned in agent-style specs under
  `docs/superpowers/`.
- **The architecture is a game loop.**
  - `RaylibHandle` and a `!Send` `RaylibThread` token, immediate-mode drawing every frame, and
    `EnableEventWaiting` to idle.
  - Nothing maps to React components, and an agent would be writing layout, text, focus,
    scrolling and widgets before porting any of Oriel.

### Verdict for Oriel

**Poor fit.**

- raylib-rs is a fine game binding with a permissive licence and good docs. Oriel needs a desktop
  UI toolkit, and raylib is not one.
- It fails accessibility and IME outright, on maintainer statements and closed PRs.
- It has no text shaping, menus, tables or trees, and it renders through OpenGL, which Apple
  deprecated.

**What choosing it would change in plan 063.** GPUI Kit would be replaced by a toolkit Oriel writes
itself. Phase 0 would grow into building layout, text, focus, scrolling, the table, menus and an
AccessKit integration before any of Oriel is ported. That exceeds the plan's whole scope, so it is
not a real alternative.

### Sources

- raylib-rs README, CLAUDE.md and LICENSE.md: <https://github.com/raylib-rs/raylib-rs> (branch
  `unstable`)
- crates.io API: <https://crates.io/api/v1/crates/raylib> and `/reverse_dependencies`;
  `sola-raylib`: <https://crates.io/crates/sola-raylib>
- Dormancy and the 6.0 publication: <https://github.com/raylib-rs/raylib-rs/issues/294>
- raylib FAQ, raylib.h and rtext.c: <https://github.com/raysan5/raylib>
- raylib 6.0 and 6.2 release notes: <https://github.com/raysan5/raylib/releases/tag/6.0>,
  <https://github.com/raysan5/raylib/releases/tag/6.2>
- The IME PR's closure: <https://github.com/raysan5/raylib/pull/2809#issuecomment-3738644145>
- raygui README and raygui.h: <https://github.com/raysan5/raygui>
- Sentiment: the links in Sentiment.

[ic-rlcrate]: https://crates.io/crates/raylib
[ic-rlreadme]: https://github.com/raylib-rs/raylib-rs/blob/unstable/README.md
[ic-rlclaude]: https://github.com/raylib-rs/raylib-rs/blob/unstable/CLAUDE.md
[ic-rllic]: https://github.com/raylib-rs/raylib-rs/blob/unstable/LICENSE.md
[ic-rl294]: https://github.com/raylib-rs/raylib-rs/issues/294
[ic-rlfaq]: https://github.com/raysan5/raylib/blob/master/FAQ.md
[ic-rlh]: https://github.com/raysan5/raylib/blob/master/src/raylib.h
[ic-rltext]: https://github.com/raysan5/raylib/blob/master/src/rtext.c
[ic-rlime]: https://github.com/raysan5/raylib/pull/2809#issuecomment-3738644145
[ic-rl60]: https://github.com/raysan5/raylib/releases/tag/6.0
[ic-rl62]: https://github.com/raysan5/raylib/releases/tag/6.2
[ic-rg]: https://github.com/raysan5/raygui
[ic-rgh]: https://github.com/raysan5/raygui/blob/master/src/raygui.h
[ic-rhn1]: https://news.ycombinator.com/item?id=44271435
[ic-rhn2]: https://news.ycombinator.com/item?id=48915956
[ic-rforum]: https://users.rust-lang.org/t/141983
## Slint

Research date: 2026-10-27. Counts read on that day; the 90-day window is 2026-07-29 to 2026-10-27.
crates.io's `recent_downloads` is its 90-day figure. Vendor quotes are labelled (V), independent
ones (I).

### In one line

Slint 1.18.1 is stable, very active and ready for agents. Its licence suits Oriel either way: GPLv3,
which makes a distributed binary GPL, or the free Royalty-free licence with an About-box credit.
But Oriel would build its own table, tree, toasts and video texture path, and would still need
native glue for macOS file drops, Finder opens and inset traffic lights.

### What it is

- A declarative GUI toolkit. The UI is written in `.slint` files, which compile to Rust (or C++,
  JavaScript, Python); the logic stays in Rust.
  - Renderers: FemtoVG (OpenGL or wgpu), Skia (Metal, Direct3D, OpenGL, Vulkan), software, and an
    experimental Vello.
  - On desktop it runs on winit by default, or on Qt ([winit backend][sq-s45]).
- Made by SixtyFPS GmbH of Hohen Neuendorf, Germany. It sells paid licence plans, embedded
  royalties and support ([pricing][sq-s5]).
  - Its top committers are Simon Hausmann (`tronical`) and Olivier Goffart (`ogoffart`).
    Goffart is also the main author of qmetaobject-rs (328 of its commits).
  - KDAB is an official Slint service partner ([KDAB][sq-s41]). Four KDAB engineers made 469 of
    Slint's 2,309 commits in the last 90 days.
  - Leon Matthes, who led CXX-Qt at KDAB, now lists himself as "Software Engineer at
    @slint-ui" ([profile][sq-s44]) and made 142 Slint commits in the window.
- 1.0 shipped on 2023-04-03, and the 1.x API has stayed stable since. Changes in language
  behaviour sit behind opt-in "editions" ([editions][sq-s35]).
  - Features named `unstable-*` are not stable. The wgpu interop has been renamed with each wgpu
    major: `unstable-wgpu-24`, 26, 27, 28, 29 and 30 between 1.10 and 1.18 ([changelog][sq-s9]).

### Licensing for Oriel

**What the texts say.**

- [LICENSE.md][sq-s1]: "You can use the Slint framework under ***any*** of the following licenses,
  at your choice": Royalty-free, GNU GPLv3, or Commercial. The crates declare
  `GPL-3.0-only OR LicenseRef-Slint-Royalty-free-2.0 OR LicenseRef-Slint-Software-3.0`.
- **GPLv3, "only" (no "or later").** From the [FAQ][sq-s3]:
  - "You can license your program under any license compatible with the GPLv3";
  - "While your software modules can remain under the MIT-license, the work as a whole must be
    licensed under the GPL."
- **Royalty-free Desktop, Mobile, and Web Applications License, version 2.0** ([text][sq-s2]). This
  is the current version; it has been unchanged in substance since 2024-05-31 (#5257, which added
  the API clause).
  - §1 grants "a world-wide, royalty-free, non-exclusive license to use, reproduce, make
    available, modify, display, perform, distribute the Software as part of a Desktop, Mobile, or
    Web Application."
  - §2, attribution. You must do either of these:
    - "(a) Display the AboutSlint widget in an "About" screen or dialog that is accessible from
      the top level menu of the Application. In the absence of such a screen or dialog, display
      the widget in the "Splash Screen" of the Application."
    - "(b) Display the Slint attribution badge on a public webpage, preferably where the binaries
      of your Application can be downloaded from, in such a way that it can be easily found by any
      visitor to that page."
  - §3 limits:
    - no distributing Slint "alone and without integration into an Application";
    - no "Embedded Systems";
    - "The License does not permit the distribution of Application that exposes the APIs, in part
      or in total, of the Software";
    - licence notices must stay.
  - LICENSE.md: the licence is "meant for applications that run on a user's own general-purpose
    computer or phone, installed as one application among many."
- **Commercial: the Slint Software License 3.0** ([text][sq-s4]). Paid seats, required for embedded,
  and a perpetual fallback licence after 12 months of payments ([pricing][sq-s5]). Oriel doesn't need
  it.
- **Can the Royalty-free licence be revoked?** Its grant says "royalty-free, non-exclusive". It
  doesn't say "perpetual" or "irrevocable".
  - The FAQ answers the takeover question by pointing to the project's pledge ([CONTRIBUTING][sq-s6]):
    "we commit to provide a royalty-free license for those who develop desktop, mobile, or web
    applications and do not want to use open-source components under copyleft licenses."
  - The Royalty-free text has no governing-law clause. The commercial licence has one (§8).
- **Contributions.** Since 2026-09-04, contributions to Slint are MIT-0, which replaced the CLA
  ([#12256][sq-s8]). This lets SixtyFPS keep offering the code under all three licences.

**Why it reads as "weird".**

- There are three licences rather than one.
- The free option for closed apps is a custom, non-OSI licence with a credit duty.
- The open option is GPL-3.0-only, which irritates GPLv2 and "or later" projects (see
  Sentiment).

None of this blocks an MIT app.

**Applied to Oriel** (MIT, public repo, built from source, a few users, not sold, perhaps unsigned
binaries):

1. **Source only, the likely case today.** Neither licence imposes a duty.
   - GPLv3 §2: "You may make, run and propagate covered works that you do not convey, without
     conditions so long as your license otherwise remains in force" ([GPLv3][sq-s7]).
   - The repo holds Oriel's MIT files, and cargo fetches Slint. No file in the repo changes
     licence.
2. **Binaries under GPLv3.** The binary as a whole is GPL-3.0. Its duties:
   - Ship the GPL text and the notices.
   - Make the Corresponding Source available. §6(d) allows "offering access from a designated
     place", so a release tag on the public repo, with `Cargo.lock`, fits. The text adds "you
     remain obligated to ensure that it is available for as long as needed".
   - Use only GPLv3-compatible linked dependencies. MIT, Apache-2.0, BSD and MPL-2.0 qualify; a
     GPL-2.0-only crate would not.
   - The bundled GPL ffmpeg and ffprobe are separate programs. GPLv3 calls such a collection an
     "aggregate".
   - The "Installation Information" duty attaches only to a "User Product", which GPLv3 defines as
     "tangible personal property which is normally used for personal, family, or household
     purposes".
3. **Binaries under Royalty-free 2.0.** No copyleft and no source duty. Instead:
   - show `AboutSlint` in an About window opened from the menu bar, or put the badge on the
     download page (the README or the release page);
   - never re-export Slint's API, for example in a plugin SDK.

   Oriel is "one application among many", not an embedded system.
4. **Forks.** Per the FAQ, a fork "can choose to use Slint under any one of the licenses". A closed
   fork needs the Royalty-free or commercial licence, or must drop Slint. The FAQ suggests adding
   a note saying so to Oriel's licence.

**What's clear and what isn't.** Items 1 to 4 follow from the texts. These questions need a lawyer:

- Can Royalty-free 2.0 be withdrawn for versions already received? The text has no
  irrevocability clause.
- Does a README on GitHub count as the "public webpage" when binaries are attached to releases?
- Would a future plugin or scripting feature count as "exposes the APIs"?
- Which law governs the Royalty-free licence?

### Oriel's needs

| Need | Support | Evidence |
|---|---|---|
| 1 Gallery of 20k+ tiles | Good: `ListView` builds only visible rows; RGBA in | [sq-s10] [sq-s12] |
| 2 Video, custom controls | Partial: texture import (wgpu, GL); no player | [sq-s15] [sq-s19] |
| 3a macOS menu bar | Good: native `MenuBar` (muda), shortcuts since 1.16 | [sq-s9] [sq-hn5] |
| 3b Clear title bar, inset lights | Workable: winit attribute hook plus objc2 | [sq-s21] [sq-s22] |
| 3c File dialogs | Gap: none (#9781 open); use `rfd` | [sq-s26] |
| 3d External file drop | Gap in 1.18 on winit; branch only; raw-event stopgap | [sq-s23] [sq-s22] |
| 3e Context menus, tooltips | Good: native context menu (1.16); `Tooltip` (1.17) | [sq-s9] |
| 3f Shortcuts, focus | Good: `FocusScope`, `forward-focus`, menu shortcuts | [sq-s9] |
| 3g Dock badge, progress | Gap: none; `NSDockTile` via objc2, as plan 063 | none |
| 3h Finder "Open With" | Gap: PR #13283 still open | [sq-s25] |
| 4a Table, 100k rows | Partial: virtualized, sort callbacks, one row, text cells | [sq-s11] |
| 4b Tree | Gap: no `TreeView` (#505, open since 2021) | [sq-s27] |
| 4c Dialogs, menus, sliders, forms | Good: std-widgets, `Dialog`, `PopupWindow` | [sq-s9] |
| 4d Sidebar, toasts | Build: layouts and an overlay or `PopupWindow` | none |
| 5 VoiceOver, IME, text | Partial: AccessKit on by default; winit IME; parley | [sq-s42] [sq-s9] |
| 6 House style | Good in own components; std-widgets restyle badly | [sq-s36] [sq-hn6] |
| 7 macOS arm64, Windows x64 | Good: macOS 14, 15, 26 tested; Windows supported | [sq-s29] |
| 8 Headless UI tests | Good: testing backend, `ElementHandle`, MCP server | [sq-s30] [sq-s31] |
| 9 Maturity | Good: stable 1.x since 2023, a minor every 2–4 months | [sq-s38] |
| 10 Licence | Good: GPLv3 or Royalty-free, both free for Oriel | [sq-s1] [sq-s2] |

Notes on the table:

- **Gallery.**
  - A Rust `Model` backs the list, and `row_data` is asked only for visible rows. So tiles can come
    from Oriel's own LRU cache.
  - `Image` "is not `Send`, because it uses internal cache that are local to the Slint thread".
    Decode into a `SharedPixelBuffer` on a worker, then wrap it on the UI thread ([source][sq-s12]).
  - GPU caching depends on the renderer:
    - Skia turns RGBA into a raster image, and Skia's own GPU cache does the upload ([sq-s43]);
    - FemtoVG keeps a texture cache whose `drain()` drops textures nobody references ([sq-s14]);
    - images loaded by path go through a 5 MiB LRU of decoded pixels ([sq-s13]).
  - Eviction means dropping the `Image`, for example by replacing the model row.
  - There is no grid view. Rows of N tiles, as plan 063 does with `uniform_list`, is the pattern.
  - 1.18 fixed slow focus moves in windows with very many elements (#13043).
- **Desktop chrome.**
  - Slint's own editor makes its title bar transparent. It sets winit's
    `with_titlebar_transparent` and `with_fullsize_content_view`, then adds an empty unified
    `NSToolbar` through objc2 ([macos_titlebar.rs][sq-s21]). Oriel would copy this.
  - File drops into a winit window landed on 2026-09-21 (#13527), but on the `feature/winit-0.31`
    branch, which is 29 commits ahead of master and 1,050 behind. The Qt backend got file drops in
    July (#12550).
  - Until that merges, `WinitWindowAccessor::on_winit_window_event` sees winit's raw
    `DroppedFile` events for the whole window ([lib.rs][sq-s22]).
- **Table.**
  - `StandardTableView` offers `sort-ascending` and `sort-descending` callbacks, `current-row` and
    text-only `StandardListViewItem` cells ([docs][sq-s11]).
  - Multi-select, icon cells and column resizing to Oriel's design mean a custom table built on
    `ListView`.
  - GPUI Kit's data table already has these.

### Video and custom GPU content

- **No player, by design.** tronical (V), 2025-12-17: "we don't intend to have built-in support for
  audio and video playback like with the video tag... with the wgpu API we have an interface for
  efficiently feeding video frames into Slint" ([#10297][sq-s19]).
- **Ways in:**
  - **Re-upload each frame.** Use `Image::from_rgba8` or `from_rgb8`. Slint's ffmpeg example
    converts each frame to RGB on the CPU and sets a new image ([example][sq-s17]).
    - An independent user saw 20–25 fps at 2560x1440 until they forced the GPU renderer;
      software fallback was the cause ([#11169][sq-s20]).
  - **wgpu texture import.** `Image::try_from(wgpu::Texture)` behind `unstable-wgpu-30`, with
    Skia or FemtoVG-wgpu (and Vello in 1.19).
    - The texture must be `Rgba8Unorm` or `Rgba8UnormSrgb`, with `TEXTURE_BINDING` and
      `RENDER_ATTACHMENT` usage ([wgpu_30.rs][sq-s15]).
    - `set_rendering_notifier` hands over the device and queue ([example][sq-s16]).
    - 1.17.1 fixed "flickering of imported WGPU textures on macOS" (#12271), so the path is in use
      on macOS.
  - **OpenGL.** `BorrowedOpenGLTextureBuilder`, or an OpenGL underlay. The GStreamer example gets
    zero-copy only on Linux, through EGL ([example][sq-s18]).
- **Oriel on macOS** (my design, unproven):
  1. Take each `CVPixelBuffer` from `AVPlayerItemVideoOutput`.
  2. Wrap it through `CVMetalTextureCache`.
  3. Import the `MTLTexture` into wgpu through wgpu-hal's Metal interop.
  4. Run one wgpu pass from BGRA or NV12 into an RGBA8 texture.
  5. Hand that texture to Slint.

  That makes one GPU copy per frame and no CPU copy. GPUI's `surface()` takes the `CVPixelBuffer`
  directly. AVPlayer still decodes, so codec coverage matches plan 063. Phase 0 must prove the
  interop and the extra pass with four players at once.
- **Windows.** Media Foundation hands out D3D11 textures. Slint's wgpu runs on DX12 or Vulkan.
  - Zero-copy means D3D11-to-D3D12 shared handles imported through wgpu-hal. The fallback is a CPU
    readback and re-upload.
  - Like GPUI, there is no released zero-copy path. Unlike GPUI, there is a public texture-import
    API on both platforms.

### Build and bundle cost

- Pure cargo. The default FemtoVG renderer needs no C++ toolchain. The Skia renderer's
  `skia-bindings` build fetches prebuilt Skia binaries, or builds Skia from source
  ([rust-skia][sq-s46]).
- The minimum Rust version is 1.95 on master, for 1.19. Plan 063 pins 1.98.
- Compile time is a known cost. "The compile times were quite something" (I, Tmpod, [sq-hn9]), and
  the `slint!` macro re-parses the widget libraries on every expansion (#12096).
- **Binary size, not measured here.** Two proxies:
  - Slint's own `slint-viewer` for macOS is a 30.0 MB universal tarball, with an interpreter and
    two architectures ([release][sq-s38]);
  - an independent Windows calculator built on Slint had a 20 MB bundle, against 207 MB for
    .NET with Avalonia (I, klibertp, [sq-hn10]).

  Electron Oriel is 503 MB.
- Packaging for macOS is a documented `.app` layout with no deploy tool to run ([packaging][sq-s47]).

### Adoption and activity

| Measure | Value |
|---|---|
| Version, cadence | 1.18.1 (2026-09-21); minors on 2026-02-04, 04-16, 06-24, 09-16 |
| 90-day commits, authors | 2,309 commits, 66 authors; `tronical` 655 and `ogoffart` 604 (55%) |
| GitHub | 24,298 stars; 731 open issues and PRs |
| `slint` on crates.io | 2,223,929 total; 827,334 in 90 days; 115 reverse dependencies |
| `i-slint-backend-testing` | 436,524 total; 353,953 in 90 days |
| Shipped desktop apps | LibrePCB 2.0 (moved from Qt), Koharu (6.5k stars), WSL Dashboard |
| More apps | (4.0k), Flectar Mail (1.7k), Czkawka's Krokiet, WesAudio's plugin |

LibrePCB 2.0 shipped on 2026-01-28: "the new user interface which was built from scratch with the
Slint UI framework" ([blog][sq-s40]). Showcase: [sq-s39].

### Sentiment

Counted on Hacker News since 2024:

- 297 comments mention Slint, and 65 of them (22%) are from Slint staff (59 by ogoffart).
- On the licence there are 31 comments. Of the independent ones, 12 are negative (from 10 people),
  6 mixed and 5 accepting. At least 4 of them misstate the terms.

Reddit was blocked (a 302 to login, then 403), so r/rust isn't counted.

- Licence:
  - "Slint is essentially proprietary-only." (I, yencabulator, 2026-02-15, [sq-hn1])
  - "the current licensing model for Slint requires either GPL3-compatible licensing of your
    work, advertising for Slint within your own software, or paying" (I, mtndew4brkfst,
    2025-06-27, [sq-hn2])
  - "We're not looking to support users who want to use it in proprietary software and give
    absolutely nothing back, not even a small credit." (V, ogoffart, 2025-06-27, [sq-hn3])
  - "I am in favor of people getting paid for the work that they do." (I, boringcactus,
    2025-04-13, [sq-b1])
- Desktop and macOS:
  - "On macOS and Windows, the menubar is native." (V, tronical, 2025-10-10, [sq-hn5])
  - "Slint is the only viable option out there", because it has a menu bar (I, bigstrat2003,
    2025-06-27, [sq-hn7])
  - "slint apps don't look and feel like anything else" (I, josephg, 2026-08-10, [sq-hn8])
  - "Cupertino in particular has fallen into an uncanny valley". Slint made Fluent the default
    style everywhere in 1.16 (V, Slint blog, 2026-03-31, [sq-s36])
  - "While they touted it as usable for desktop applications it really wasn't ready" (I, wezm,
    2025-10-09, [sq-l1])
- Theming and the DSL:
  - "the biggest pain point is the very limited theming support" (I, Tmpod, 2026-04-13, [sq-hn6])
  - "This DSL kinda rules, I can't lie" (I, boringcactus, 2025-04-13, [sq-b1])
- Against GPUI Kit:
  - IshKebab (I, 2026-02-13, [sq-hn4]) needed a million-row virtualized table. They called
    gpui-component "Definitely the best option today". Slint was among the "other reasonable
    choices", "though in some ways it is weird and it requires quite a lot of boilerplate setup".
  - The 2026 Rust GUI survey picks "slint and egui", adding GPUI Component in an edit on
    2026-08-25 (I, wybxc, [sq-b2]).
- Switches:
  - **GPUI to Slint:** juicity-rs, 2026-10-10. GPUI needs Vulkan on Linux, so the window wouldn't
    open in VMs or remote desktops ([PR][sq-g1]).
  - **Tauri and React to Slint:** any-player, a media player, 2026-10-27 ([PR][sq-g2]).
  - **Qt to Slint:** LibrePCB.
  - **Away from Slint:** Slint to egui (2024), and Slint to ratatui to Qt (2025), both on HN.
  - None of these moved Slint to GPUI Kit, or the reverse, on macOS.

### Fit for an agent-written port

- **Official agent guidance, better than most.**
  - A Slint skill for Claude Code, Codex and others ([guide][sq-s31], [skill][sq-s32]).
  - An MCP server compiled into the running app, which lets an agent read the accessibility tree,
    send input and take screenshots (feature `mcp`).
  - `AGENTS.md` and `CLAUDE.md` in the repo, and a generated `llms.txt` ([sq-s33]), so far only on
    the master snapshot docs.
- **The DSL is well documented,** and the compiler type-checks bindings, so agents get errors early.
  - But `.slint` is niche, with far less training data than React or QML. Agents will lean on the
    skill, the language server and live preview.
  - Editions keep behaviour changes from breaking an existing port.
- **From React and Tailwind:**
  - components map to `component`, props to `in property`, and state to properties with two-way
    bindings. Slint's own "Reactivity vs React.js" guide covers the shift to fine-grained
    reactivity ([sq-s34]);
  - flex maps to `HorizontalLayout`, `VerticalLayout` and `FlexboxLayout` (1.18);
  - Tailwind tokens become a `global Theme`, and hover and focus become `states` and `animate`;
  - utility-class composition has no equivalent, so each look becomes a component;
  - Lucide icons come in as SVG with `colorize`.

### Verdict for Oriel

**Fit with caveats.** Slint is the most mature pure-Rust option. It has a semver-stable 1.x, a
funded team with KDAB alongside, AccessKit and test tooling, and its licence costs Oriel nothing.
The caveats: fewer ready-made desktop components than GPUI Kit, macOS chrome that still needs
objc2, and a video path that ends in a GPU copy.

Changes to plan 063 compared with GPUI Kit:

- **Versions.** D1 goes. Pin `slint = "=1.18.x"` with the Skia renderer on Metal and
  `unstable-wgpu-30`. Bump by hand, since the wgpu feature is renamed each release.
- **Licence.** Add a licence decision: GPLv3 (binaries GPL) or Royalty-free (`AboutSlint` in an
  About window).
- **UI code.** The UI moves into `.slint` files. `crates/ui` becomes a `.slint` component library
  with a `Theme` global built from the `lw-*` tokens, overriding the Fluent default.
- **Components to write:**
  - a data table with multi-select and custom cells;
  - a tree;
  - toasts;
  - the sidebar and float panel.
- **Video.** It becomes AVPlayer to Metal to wgpu, plus one conversion pass. Windows is the same
  open problem as with GPUI.
- **Shell.** Add native glue for file drops (until winit 0.31 merges), Finder opens, inset traffic
  lights, `rfd` for file dialogs, and the Dock.
- **Tests and skills.** Tests use `i-slint-backend-testing` and the MCP server. Vendor Slint's
  skill instead of GPUI Kit's.

### Sources

[sq-s1]: https://github.com/slint-ui/slint/blob/master/LICENSE.md
[sq-s2]: https://github.com/slint-ui/slint/blob/master/LICENSES/LicenseRef-Slint-Royalty-free-2.0.md
[sq-s3]: https://github.com/slint-ui/slint/blob/master/FAQ.md#licensing
[sq-s4]: https://github.com/slint-ui/slint/blob/master/LICENSES/LicenseRef-Slint-Software-3.0.md
[sq-s5]: https://slint.dev/pricing
[sq-s6]: https://github.com/slint-ui/slint/blob/master/CONTRIBUTING.md#our-open-source-pledge
[sq-s7]: https://www.gnu.org/licenses/gpl-3.0.html
[sq-s8]: https://github.com/slint-ui/slint/pull/12256
[sq-s9]: https://github.com/slint-ui/slint/blob/master/CHANGELOG.md
[sq-s10]: https://docs.slint.dev/latest/docs/slint/reference/std-widgets/views/listview/
[sq-s11]: https://docs.slint.dev/latest/docs/slint/reference/std-widgets/views/standardtableview/
[sq-s12]: https://github.com/slint-ui/slint/blob/master/internal/core/graphics/image.rs
[sq-s13]: https://github.com/slint-ui/slint/blob/master/internal/core/graphics/image/cache.rs
[sq-s14]: https://github.com/slint-ui/slint/blob/master/internal/renderers/femtovg/images.rs
[sq-s15]: https://github.com/slint-ui/slint/blob/master/internal/core/graphics/wgpu_30.rs
[sq-s16]: https://github.com/slint-ui/slint/tree/master/examples/wgpu_texture
[sq-s17]: https://github.com/slint-ui/slint/tree/master/examples/ffmpeg
[sq-s18]: https://github.com/slint-ui/slint/tree/master/examples/gstreamer-player
[sq-s19]: https://github.com/slint-ui/slint/issues/10297
[sq-s20]: https://github.com/slint-ui/slint/issues/11169
[sq-s21]: https://github.com/slint-ui/slint/blob/master/tools/lsp/preview/macos_titlebar.rs
[sq-s22]: https://github.com/slint-ui/slint/blob/master/internal/backends/winit/lib.rs
[sq-s23]: https://github.com/slint-ui/slint/pull/13527
[sq-s24]: https://github.com/slint-ui/slint/pull/12550
[sq-s25]: https://github.com/slint-ui/slint/pull/13283
[sq-s26]: https://github.com/slint-ui/slint/issues/9781
[sq-s27]: https://github.com/slint-ui/slint/issues/505
[sq-s29]: https://github.com/slint-ui/slint/blob/master/docs/astro/src/content/docs/guide/platforms/desktop/macos/general.mdx
[sq-s30]: https://github.com/slint-ui/slint/blob/master/docs/astro/src/content/docs/guide/experimental/testable.mdx
[sq-s31]: https://github.com/slint-ui/slint/blob/master/docs/astro/src/content/docs/guide/tooling/ai-coding-assistants.mdx
[sq-s32]: https://github.com/slint-ui/ai-plugins
[sq-s33]: https://snapshots.slint.dev/master/docs/slint/llms.txt
[sq-s34]: https://github.com/slint-ui/slint/blob/master/docs/astro/src/content/docs/guide/language/concepts/reactivity-vs-react.mdx
[sq-s35]: https://github.com/slint-ui/slint/blob/master/docs/astro/src/content/docs/guide/language/concepts/editions.mdx
[sq-s36]: https://slint.dev/blog/default-native-style-change
[sq-s37]: https://crates.io/crates/slint
[sq-s38]: https://github.com/slint-ui/slint/releases/tag/v1.18.1
[sq-s39]: https://slint.dev/showcase
[sq-s40]: https://librepcb.org/blog/2026-01-28_release_2.0.0/
[sq-s41]: https://www.kdab.com/software-technologies/slint/
[sq-s42]: https://github.com/slint-ui/slint/blob/master/api/rs/slint/Cargo.toml
[sq-s43]: https://github.com/slint-ui/slint/blob/master/internal/renderers/skia/cached_image.rs
[sq-s44]: https://github.com/LeonMatthes
[sq-s45]: https://github.com/slint-ui/slint/blob/master/docs/astro/src/content/docs/guide/backends-and-renderers/backend_winit.md
[sq-s46]: https://github.com/rust-skia/rust-skia
[sq-s47]: https://github.com/slint-ui/slint/blob/master/docs/astro/src/content/docs/guide/platforms/desktop/packaging/macos.mdx
[sq-hn1]: https://news.ycombinator.com/item?id=47026673
[sq-hn2]: https://news.ycombinator.com/item?id=44396297
[sq-hn3]: https://news.ycombinator.com/item?id=44397404
[sq-hn4]: https://news.ycombinator.com/item?id=47003586
[sq-hn5]: https://news.ycombinator.com/item?id=45543060
[sq-hn6]: https://news.ycombinator.com/item?id=47757439
[sq-hn7]: https://news.ycombinator.com/item?id=44399065
[sq-hn8]: https://news.ycombinator.com/item?id=49242498
[sq-hn9]: https://news.ycombinator.com/item?id=46354467
[sq-hn10]: https://news.ycombinator.com/item?id=49271580
[sq-l1]: https://lobste.rs/c/azhqu6
[sq-b1]: https://www.boringcactus.com/2025/04/13/2025-survey-of-rust-gui-libraries.html
[sq-b2]: https://blog.wybxc.cc/blog/rust-gui-survey-2026/
[sq-g1]: https://github.com/juicity/juicity-rs/pull/20
[sq-g2]: https://github.com/neboman11/any-player/pull/80

Repository statistics come from `gh api` (commits on `master` since 2026-07-29, releases,
contributors). Downloads come from the crates.io API.

## Qt from Rust (Qt Bridges, CXX-Qt)

### In one line

Qt 6.12 LTS covers more of Oriel than any Rust-native toolkit: a real video player with hardware
decode on both platforms, `TableView` and `TreeView`, native menus and dialogs. Its LGPL is easy
for an MIT app. But the Rust bridges are young, the UI moves into QML, and the build gains Qt and a
C++ toolchain.

- The Qt Bridge for Rust reached Technology Preview today, and its macOS arm64 support is marked
  "experimental".
- CXX-Qt is at 0.10 and thinly maintained.

### What it is

- **"qt bridge for rust" most likely means Qt Group's [Qt Bridge for Rust][sq-q24].** That is the
  product's exact name, and Qt has promoted it all year. CXX-Qt is a close second: its central
  macro is `#[cxx_qt::bridge]`. Both exist, and they now share code.
- **Qt Bridge for Rust**, part of Qt Bridges (Qt Group). Repo `qt/qtbridge-rust`, crate `qtbridge`
  0.4.0 (2026-10-26).
  - What it does: a QML UI talks to a Rust backend through `#[qobject]`, `#[qproperty]`,
    `#[qslot]` and `#[qsignal]`, with "no C++ headers, no manual FFI".
  - History:
    - announced at Qt World Summit 2025;
    - public beta on 2026-07-01 ([sq-q25]);
    - beta 0.3 on 2026-09-23, rebased on CXX-Qt's types ([sq-q27]);
    - **Technology Preview on 2026-10-27** ([sq-q28]).
  - "APIs, supported platforms and requirements can still change before the stable release", which
    is planned for "first quarter of 2027".
  - Requirements: Qt 6.10 or later, `qmake` on `PATH` and a C++ toolchain. Platforms: Linux
    x86_64, Windows x64, "macOS (`arm64`) - experimental" ([README][sq-q24]).
  - Scope, from the README: "If your project requires mixing Rust and C++ code, using Qt Widgets,
    or accessing Qt modules that only provide a C++ API, consider using CXX-Qt instead."
- **CXX-Qt** (KDAB; MIT OR Apache-2.0), 0.10.0 (2026-08-24): "CXX-Qt is in early development and
  the API changes frequently" ([README][sq-q29]).
  - It generates `QObject` subclasses in Rust, and `cxx-qt-lib` binds common QtCore, QtGui and
    QML types.
  - You can declare more Qt C++ API in `extern "C++"` blocks, subclass Qt classes (`#[base]`,
    `#[cxx_override]`; see the `QQuickPaintedItem` example [sq-q32]) and compile `.cpp` files (0.8).
  - Its examples run Qt Quick Test QML tests through a C++ `main` ([sq-q34]).
  - Experimental "Qt Minimal" support downloads a Qt 6.10 snapshot for QML-only use ([sq-q31]).
- **Other routes:**
  - qmetaobject-rs (Woboq; MIT): 0.2.10 from 2023-11-03, and 10 commits in 12 months from one
    person. Qt's own blog calls it "now passively maintained" ([sq-q26]).
  - rust-qt (ritual), qml-rust and the others in CXX-Qt's comparison table are unmaintained.
  - Slint's Qt backend draws Slint UIs with Qt; it isn't a route to Qt Quick.
- **Qt itself.** 6.12.0 LTS, released 2026-09-30 ([sq-q39]). Qt Group sells commercial licences; the
  Qt Project develops in the open, and KDAB is a long-time contributor.
- **Who works on the bridges, in the last 90 days:**
  - qtbridge-rust: 142 commits from 5 authors, at least 4 of them with qt.io addresses.
  - CXX-Qt: 18 commits from 5 authors. 10 came from a Qt Group engineer adding what the bridge
    needs. KDAB's one commit was the 0.10.0 version bump, and CXX-Qt's former lead now works at
    Slint.

### Licensing for Oriel

**What the texts say.**

- From [Qt Licensing][sq-q1] for 6.12:
  - "Qt licensed under the GNU Lesser General Public License (LGPL) version 3 is appropriate for
    the development of Qt applications provided you can comply with the terms and conditions of
    the GNU LGPL version 3 (or GNU GPL version 3)."
  - "For open-source licensed Qt, some specific parts (modules) are not available under the GNU
    LGPL version 3, but under the GNU General Public License (GPL) instead."
- **GPL-only modules in 6.12:** Qt Canvas Painter, Qt CoAP, Qt Graphs, Qt GRPC, Qt HTTP Server, Qt
  Lottie Animation, Qt MQTT, Qt Network Authorization, Qt Qml Compiler, Qt Quick 3D, Qt Quick 3D
  Physics, Qt Quick Timeline, Qt Virtual Keyboard, Qt Wayland Compositor.
- **Tools** such as `macdeployqt` are "GPL version 3, with Qt GPL exception 1.0". Examples are
  BSD-3-Clause.
- **What Oriel needs is LGPL.** Qt Core, Gui, Qml, Quick, Quick Controls, Quick Dialogs, Quick
  Layouts, Quick Effects, Multimedia, SVG and Image Formats are all off the GPL-only list.
  - Qt Multimedia's page: "available under free software licenses", "GNU Lesser General Public
    License, version 3, or GPL version 2" ([sq-q4]).
  - Avoid the GPL-only Qt Qml Compiler (`qmlsc`), Qt Quick Timeline and Qt Graphs, or accept that
    using one makes Oriel's binaries GPL as a whole. For an MIT app that is allowed, as with
    Slint's GPL option.
- **LGPLv3 §4, for conveying a Combined Work** ([LGPLv3][sq-q3]). You must do all of these:
  - "(a) Give prominent notice with each copy of the Combined Work that the Library is used in it
    and that the Library and its use are covered by this License";
  - "(b) Accompany the Combined Work with a copy of the GNU GPL and this license document";
  - (d) do one of the following:
    - "0) Convey the Minimal Corresponding Source ... and the Corresponding Application Code in a
      form suitable for, and under terms that permit, the user to recombine or relink";
    - "1) Use a suitable shared library mechanism ... (a) uses at run time a copy of the Library
      already present on the user's computer system, and (b) will operate properly with a
      modified version of the Library";
  - (e) provide Installation Information "only if you would otherwise be required to provide such
    information under section 6 of the GNU GPL", which means User Products, physical goods.
- **Qt's own summary** ([sq-q2]):
  - "the complete corresponding source code has to be delivered even if the library has not been
    modified at all";
  - "In case of static linking of the library, the application itself may no longer be 'work
    that uses the library'";
  - users must get "a copy of the LGPL license text" and "a prominent notice";
  - "some means of distribution, such as online application stores, may have rules that are in
    conflict with LGPL".
- **The bridge crates' own licences:**
  - `qtbridge` and `qtbridge-runtime`: `LicenseRef-Qt-Commercial OR LGPL-3.0-only`. For commercial
    licensees, Qt Bridges "constitutes Pre-Release Code".
  - `cxx-qt`, `cxx-qt-lib`, `cxx-qt-build`, `qt-build-utils`, `qt-version`, `qt-artifacts`: MIT OR
    Apache-2.0.
  - `qmetaobject`, `qttypes`: MIT.
- **FFmpeg inside Qt Multimedia.** Shared libraries, LGPL-2.1-or-later. The prebuilt libraries "are
  only including features that agree with the permissive licenses". On patents: "The Qt licenses
  do not cover such fees" ([sq-q4]).

**Applied to Oriel.**

1. **Source only.** No duty; the LGPL and GPL don't restrict private use.
2. **Binaries.**
   - `macdeployqt` copies Qt into the bundle as private frameworks, which is dynamic linking.
   - Add the LGPL and GPL texts, an About notice that Qt is used, and a link or written offer for
     the exact Qt 6.12.x source from download.qt.io. Add FFmpeg's notices too.
   - Oriel's own GPL ffmpeg executables stay separate programs.
3. **`qtbridge` links statically,** like any Rust crate, so §4(d)(1) doesn't apply to it.
   - §4(d)(0) asks for the application in a relinkable form. Oriel's public MIT source with
     `Cargo.lock` is exactly that, if it is published alongside the binaries.
   - CXX-Qt adds no copyleft.
4. **Getting Qt.** The official online installer says "Create an account at Qt Account" ([sq-q22]).
   Homebrew's `qt` (6.12.0) or a source build avoid the account.

**What's clear and what isn't.** It is clear that every module Oriel needs is LGPL, what the duties
are, and that an MIT app may combine with both LGPL and GPL Qt. These questions need a lawyer:

- Does Qt shipped inside the `.app` meet §4(d)(1)'s "already present on the user's computer
  system"? Oriel can lean on §4(d)(0) through its public source either way.
- How does the static `qtbridge` work if binaries ever ship without source?
- What is the patent exposure of FFmpeg's software H.264 and HEVC decoders? The hardware
  VideoToolbox path decodes in macOS.

### Oriel's needs

| Need | Support | Evidence |
|---|---|---|
| 1 Gallery of 20k+ tiles | Good: views reuse a delegate pool; async images | [sq-q16] |
| 2 Video, custom controls | Good: `MediaPlayer` and `VideoOutput`, QML on top | [sq-q4] [sq-q5] |
| 3a macOS menu bar | Good: `MenuBar` native on macOS since 6.8 | [sq-q9] |
| 3b Clear title bar, inset lights | Partial: 6.9 window flags; inset needs NSWindow | [sq-q11] |
| 3c File dialogs | Good: `FileDialog` native on macOS | [sq-q12] |
| 3d External file drop | Good: `DropArea` takes URLs from other apps | [sq-q13] |
| 3e Context menus, tooltips | Good: `Menu` with `Popup.Native` (6.8); `ToolTip` | [sq-q10] |
| 3f Shortcuts, focus | Good: `Shortcut` with context; `FocusScope` | [sq-q14] |
| 3g Dock badge, progress | Partial: `setBadgeNumber` (6.5); progress via objc2 | [sq-q15] |
| 3h Finder "Open With" | Good: Qt delivers `QFileOpenEvent`; needs a bridge | none |
| 4a Table, 100k rows | Good: `TableView`, selection model, header, sorting | [sq-q16] [sq-q18] |
| 4b Tree | Good: `TreeView` (since 6.3) | [sq-q17] |
| 4c Dialogs, menus, sliders, forms | Good: Qt Quick Controls | [sq-q10] |
| 4d Sidebar, toasts | Build: `ListView`, `Drawer`, `Popup` | none |
| 5 VoiceOver, IME, text | Good: platform accessibility APIs; native IME | [sq-q19] |
| 6 House style | Good: custom style, corner radii (6.7), `MultiEffect` | [sq-q40] |
| 7 macOS arm64, Windows x64 | Qt good; Bridges' macOS arm64 "experimental" | [sq-q24] |
| 8 Headless UI tests | Good in QML: Qt Quick Test, offscreen; Squish (paid) | [sq-q20] [sq-q34] |
| 9 Maturity | Qt mature; Bridges at TP, CXX-Qt at 0.10 | table below |
| 10 Licence | Good: LGPLv3 modules; LGPL `qtbridge` crate | [sq-q1] [sq-q24] |

Notes on the table:

- **Gallery.**
  - `TableView` "inherits Flickable"; flicked-out items move "to the reuse pool", and delegates
    get `pooled` and `reused` signals ([sq-q16]). `GridView` follows the same pattern.
  - Oriel's WebP thumbnails load as files through Qt Image Formats.
  - RGBA from Rust needs a `QQuickImageProvider`. CXX-Qt 0.9 binds `addImageProvider`, which
    takes a raw provider pointer ([sq-q33]), so the subclass is a small C++ or `#[base]` shim. Qt
    Bridges has no image provider.
  - The scene graph manages textures, and eviction follows delegate pooling and Qt's pixmap cache
    (`Image.cache`). Measure it in Phase 0.
- **Title bar.** `Qt::ExpandedClientAreaHint` "requests that the window's client area is expanded"
  under the title bar, and `Qt::NoTitleBarBackgroundHint` draws it "without a background color".
  Both arrived in 6.9. Moving the traffic lights needs `NSWindow` calls on `winId()`, through
  objc2.
- **Sorting.** The `SortFilterProxyModel` QML type exists since Qt 6.10 ([sq-q18]).
  - Qt Bridges "bind[s] QML views to Rust collections" with list and table model traits.
  - CXX-Qt can subclass `QAbstractTableModel`.
- **Bridges only reach Qt's QML side,** so menus, dialogs and `DropArea` work from QML in both
  bridges. Anything that is C++-only, such as `QFileOpenEvent` (for Finder "Open With") or
  `NSWindow` access, needs CXX-Qt or C++.

### Video and custom GPU content

- **The player.**
  - QML's `MediaPlayer` and `VideoOutput` play the file, and the capsule controls are QML items
    layered above.
  - Both bridges can use them, since they are QML types. Rust only exposes the URL and state.
  - To call `QMediaPlayer` from Rust, CXX-Qt lets you declare the binding yourself. Qt Bridges
    defers to CXX-Qt.
- **Backends.**
  - FFmpeg is "the default on all platforms except WebAssembly and embedded Linux/Boot2Qt".
  - Native alternatives include "AVFoundation on macOS and iOS" (`QT_MEDIA_BACKEND=darwin`) and
    "Windows Media Foundation on Windows (deprecated since Qt 6.10)" ([sq-q4]).
- **Hardware decode.**
  - "The FFmpeg plugin chooses the hardware acceleration backend for decoding and encoding based
    on availability". The list includes `videotoolbox`, `d3d11va`, `d3d12va` and `dxva2`.
  - "Utilizing GPU-based conversion for decoded and rendered video frames can significantly reduce
    CPU usage" ([sq-q5]).
- **Codecs.**
  - Qt's CI builds FFmpeg with stock options plus a few `--disable` flags. It enables no external
    codec libraries and no GPL parts ([sq-q6]).
  - So H.264, HEVC, VP8 and VP9 decode with FFmpeg's own decoders (my reading of FFmpeg's
    defaults). MKV, WebM, AVI and FLV demux.
  - AV1 has no dav1d in that build, so it rests on hardware decode through VideoToolbox (an M3 or
    later). This is unverified.
  - The darwin backend plays what AVFoundation plays. Check both with `QMediaFormat` in Phase 0.
- **Upside for Oriel.** The FFmpeg backend may play the MKV, WebM, AVI and FLV files that plan 063
  shows as "Can't play here". Windows (Phase 8) gets D3D11VA decode with the same QML player.
- **Feeding your own frames.**
  - `QVideoSink` with a `QAbstractVideoBuffer` (public since 6.8) maps frames "to CPU memory"
    ([sq-q7]), so each frame is re-uploaded.
  - Zero-copy GPU content uses `QNativeInterface::QSGMetalTexture::fromNative` (since 6.0) in a
    custom `QQuickItem`, or `QQuickRhiItem` ([sq-q8]). That is C++, which CXX-Qt can host and Qt
    Bridges can't.

### Build and bundle cost

- **Toolchain.**
  - Qt 6.10 or later (6.12 LTS today), `qmake` on `PATH` and a C++ toolchain: the Xcode command
    line tools on macOS, MSVC 2022 on Windows ([sq-q24]).
  - Qt Group's dev blog: "a C++ compiler and toolchain are still required, since cargo is
    rebuilding all crates from source code" ([sq-q26]).
- **Compile time.** From the 0.3 beta post: "compile times increased substantially with the move to
  CXX-Qt" ([sq-q27]). Also "crippling compile times" (I, throwup238, [sq-hq1]).
- **Install size.** Qt 6.12.0 for macOS ships universal x86_64 and arm64 packages ([sq-q23]):
  - `qtbase`: 30 MB compressed;
  - `qtdeclarative`: 160 MB;
  - `qtmultimedia`: 55 MB;
  - `qttools`: 47 MB.
- **Deploy.**
  - `macdeployqt` builds "a deployable application bundle that contains Qt libraries as private
    frameworks". Its `-qmldir` option pulls in QML imports, and it signs ad hoc by default or
    `-sign-for-notarization` ([sq-q21]). `windeployqt` does the same on Windows.
  - FFmpeg's dylibs come with the multimedia plugin.
- **Bundle size, not measured here.**
  - A Qt 6.4 app's DMG grew from 38 MB on Qt 5 to 77 MB on Qt 6, partly from
    `libffmpegmediaplugin.dylib` (I, Qt interest list, 2023-06-01, [sq-q41]).
  - Thinning the universal Qt binaries to arm64 should roughly halve Qt's share. That is my
    inference from the universal packages.
  - Expect tens of MB to low hundreds, against Electron Oriel's 503 MB.

### Adoption and activity

| Measure | Qt Bridge for Rust | CXX-Qt | qmetaobject-rs |
|---|---|---|---|
| Version, 1.0? | 0.4.0, TP; stable Q1 2027 | 0.10.0; pre-1.0 | 0.2.10 (2023) |
| Cadence | 0.2 Jul, 0.3 Sep, 0.4 Oct 2026 | 0.8 Dec, 0.9 Jun, 0.10 Aug | passive |
| 90-day commits | 142, 5 authors (Qt Group) | 18, 5 authors | 0 (10 in 12 months) |
| Stars | 301 | 1,565 | 735 |
| crates.io total | 3,787 | 146,718 | 115,802 |
| crates.io, 90 days | 2,895 | 69,176 | 10,657 |
| Reverse dependencies | 0 | 6 (`cxx-qt-lib`: 7) | 7 |
| Notable Rust apps | none found | shrimply (1.2k), omikuji (239) | none checked |

- `qttypes`, from qmetaobject-rs, shows 134,871 downloads in 90 days. Most come from Slint's Qt
  backend, which depends on it.
- Qt itself has no adoption question: 6.12 is an LTS release.

### Sentiment

Counted on Hacker News since 2024: about 24 independent comments name CXX-Qt. About 8 are
positive, 7 negative and 9 neutral, and one heavy user wrote 6 of them. Qt Bridges has drawn little
discussion: the beta story got 3 points and no comments. Reddit was blocked.

- CXX-Qt:
  - "the ergonomics are rather shit due to the use of Pin<&mut T> everywhere" (I, throwup238,
    2024-08-18, [sq-hq2])
  - "I welcome you to try to work on a cxx-qt project to understand what crippling compile times
    look like." (I, throwup238, 2025-10-30, [sq-hq1])
  - Their sample code "will not run due to 1058 linker errors" on Windows (I, boringcactus,
    2025-04-13, [sq-b1])
  - "while excellent, is designed for teams already living in C++" (V, Qt Group, 2026-07-01,
    [sq-q26])
- Qt Bridges:
  - "for Qt6, qtbridge-rust seemed like a better experience to me than CXX-Qt." (I,
    hoistbypetard, 2026-08-22, [sq-l2])
- QML:
  - "I found QML to be a terrible language for making GUIs." (I, IshKebab, 2025-12-16, [sq-hq3])
  - IshKebab (I, 2026-10-26, [sq-hq4]): "I quite like gpui-kit (formerly gpui-component). Maybe not
    as easy to use as Qt but it doesn't matter so much now with AI."
- Accessibility: "if you want to have good accessibility story you should probably look at Slint
  or Qt (via cxx-qt, for example)" (I, andrewl-hn, 2025-10-27, [sq-hq5]). This compared them with
  GPUI before GPUI Kit's AccessKit work.
- No project was found that moved between Qt from Rust and GPUI in either direction. LibrePCB went
  from Qt to Slint.

### Fit for an agent-written port

- **QML.** Agents know it well: it has a large corpus and deep docs.
  - Qt publishes official "Qt AI Skills" under BSD-3-Clause, including `qt-qml`, `qt-qml-review`,
    `qt-qml-test` and `qt-qml-test-run`, for Claude Code, Codex, Gemini CLI and Copilot.
  - It also runs a hosted docs MCP server for "Qt 6.8.4 (LTS) and Qt 6.11.0" ([sq-q36]).
  - The commercial Qt AI Assistant is retiring, with support ending on 2026-12-31 ([sq-q37]).
- **The Rust side has no official agent guidance.**
  - Both bridges change between releases: Bridges 0.3 had breaking changes, and CXX-Qt's minors
    break.
  - Agents would juggle Rust, QML with its JavaScript, and C++ shims for image providers, native
    textures and `NSWindow`, and would have to debug C++ linker errors.
- **From React and Tailwind:**
  - QML's object tree reads like JSX, and properties with bindings replace props and state;
  - flex maps to `RowLayout`, `ColumnLayout` and `Flow`, and anchors cover the rest;
  - Tailwind tokens become a QML singleton `Theme`, and controls get a custom Qt Quick Controls
    style;
  - Lucide icons come in as SVG.
  - "No Node" still holds, but the QML engine runs JavaScript in bindings.

### Verdict for Oriel

**Fit with caveats.** For Oriel's hardest parts, Qt is the strongest of the three toolkits: video
on macOS and Windows, a 100k-row table, a tree, and native menus, dialogs and drops. The caveats:

- a heavier two-toolchain build and a larger bundle;
- a UI in QML rather than Rust;
- Rust bridges that are a Technology Preview (Bridges, with macOS arm64 experimental) or pre-1.0
  and thinly maintained (CXX-Qt).

Changes to plan 063 compared with GPUI Kit:

- **The bridge choice.** D1 becomes "which bridge". Start on Qt Bridge for Rust 0.4 and use CXX-Qt
  for C++-only needs; the two share foundations and are meant to coexist. Fall back to CXX-Qt
  alone if Bridges fails on macOS arm64 in Phase 0.
- **Pins.** Qt 6.12 LTS, `qtbridge`, and `cxx-qt` exactly.
- **UI code.** The UI becomes QML under the app, with Rust `#[qobject]` backends. `crates/ui`
  becomes a custom Qt Quick Controls style built from the `lw-*` tokens.
- **Video.** `crates/media` becomes Qt Multimedia: FFmpeg with VideoToolbox, or the darwin
  backend. It may play formats plan 063 gives up on, and Phase 8's Windows video mostly comes with
  it.
- **Stills.** ImageIO decode stays in Rust, fed in through an image provider shim.
- **Packaging.** `macdeployqt` and `windeployqt`, the LGPL notices and a Qt source offer.
- **Tests and skills.**
  - Shell tests use Qt Quick Test, run offscreen, beside `cargo test`.
  - Vendor Qt's QML skills instead of GPUI Kit's.

### Sources

[sq-q1]: https://doc.qt.io/qt-6/licensing.html
[sq-q2]: https://www.qt.io/licensing/open-source-lgpl-obligations
[sq-q3]: https://www.gnu.org/licenses/lgpl-3.0.html
[sq-q4]: https://doc.qt.io/qt-6/qtmultimedia-index.html
[sq-q5]: https://doc.qt.io/qt-6/advanced-ffmpeg-configuration.html
[sq-q6]: https://github.com/qt/qt5/blob/dev/coin/provisioning/common/shared/ffmpeg_config_options.txt
[sq-q7]: https://doc.qt.io/qt-6/qabstractvideobuffer.html
[sq-q8]: https://doc.qt.io/qt-6/qnativeinterface-qsgmetaltexture.html
[sq-q9]: https://doc.qt.io/qt-6/qml-qtquick-controls-menubar.html
[sq-q10]: https://doc.qt.io/qt-6/qml-qtquick-controls-menu.html
[sq-q11]: https://doc.qt.io/qt-6/qt.html#WindowType-enum
[sq-q12]: https://doc.qt.io/qt-6/qml-qtquick-dialogs-filedialog.html
[sq-q13]: https://doc.qt.io/qt-6/qml-qtquick-droparea.html
[sq-q14]: https://doc.qt.io/qt-6/qml-qtquick-shortcut.html
[sq-q15]: https://doc.qt.io/qt-6/qguiapplication.html#setBadgeNumber
[sq-q16]: https://doc.qt.io/qt-6/qml-qtquick-tableview.html
[sq-q17]: https://doc.qt.io/qt-6/qml-qtquick-treeview.html
[sq-q18]: https://doc.qt.io/qt-6/qml-qtqml-models-sortfilterproxymodel.html
[sq-q19]: https://doc.qt.io/qt-6/accessible.html
[sq-q20]: https://doc.qt.io/qt-6/qtquicktest-index.html
[sq-q21]: https://doc.qt.io/qt-6/macos-deployment.html
[sq-q22]: https://doc.qt.io/qt-6/qt-online-installation.html
[sq-q23]: https://download.qt.io/online/qtsdkrepository/mac_x64/desktop/qt6_6120/qt6_6120/
[sq-q24]: https://github.com/qt/qtbridge-rust
[sq-q25]: https://www.qt.io/blog/qt-bridges-public-beta-for-rust
[sq-q26]: https://www.qt.io/blog/rust-ui-framework-via-bridging-technology
[sq-q27]: https://www.qt.io/blog/qt-bridge-for-rust-0.3-cxx-qt-compatibility-and-soundness
[sq-q28]: https://www.qt.io/blog/qt-bridges-technology-preview-rust-csharp
[sq-q29]: https://github.com/KDAB/cxx-qt
[sq-q30]: https://github.com/KDAB/cxx-qt/blob/main/CHANGELOG.md
[sq-q31]: https://github.com/KDAB/cxx-qt/blob/main/book/src/getting-started/6-cargo-qt-minimal.md
[sq-q32]: https://github.com/KDAB/cxx-qt/blob/main/examples/qml_features/rust/src/custom_parent_class.rs
[sq-q33]: https://github.com/KDAB/cxx-qt/blob/main/crates/cxx-qt-lib/src/qml/qqmlengine.rs
[sq-q34]: https://github.com/KDAB/cxx-qt/tree/main/examples/qml_features/tests
[sq-q35]: https://github.com/woboq/qmetaobject-rs
[sq-q36]: https://doc.qt.io/agentictools/
[sq-q37]: https://www.qt.io/blog/qt-ai-assistant-retires-as-we-invest-in-agentic-development-tools
[sq-q38]: https://crates.io/crates/qtbridge
[sq-q39]: https://download.qt.io/official_releases/qt/6.12/6.12.0/
[sq-q40]: https://doc.qt.io/qt-6/qml-qtquick-rectangle.html
[sq-q41]: https://lists.qt-project.org/pipermail/interest/2023-June/039118.html
[sq-hq1]: https://news.ycombinator.com/item?id=45760046
[sq-hq2]: https://news.ycombinator.com/item?id=41284331
[sq-hq3]: https://news.ycombinator.com/item?id=46294878
[sq-hq4]: https://news.ycombinator.com/item?id=50241859
[sq-hq5]: https://news.ycombinator.com/item?id=45721492
[sq-l2]: https://lobste.rs/c/kvinug

Repository statistics come from `gh api`: `qt/qtbridge-rust` on `dev`, `KDAB/cxx-qt` on `main`,
`woboq/qmetaobject-rs` on `master`. Downloads come from the crates.io API.
## Dioxus Native (Blitz)

Research date: 2026-10-27. Versions, counts and issue states were read that day from GitHub
(`gh api`), the crates.io API and the projects' own sites. "90 days" means 2026-07-29 to
2026-10-27; crates.io's `recent_downloads` is also a 90-day count.

### In one line

Dioxus drawing real HTML and CSS through its own beta engine, Blitz: the only option that could
keep much of Oriel's Tailwind markup, but video, a virtualized gallery and table, the menu bar,
keyboard focus and screen-reader actions are missing or must be built by hand.

### What it is

- **Dioxus** is a React-like UI framework for Rust: components, hooks, signals and the `rsx!`
  macro. One codebase targets web (wasm), desktop (a webview), mobile, and "native".
- **Dioxus Native** (`dioxus-native`) runs the Dioxus virtual DOM against Blitz's DOM. There is
  no webview and no JavaScript engine; event handlers are Rust closures. Start it with
  `dx serve --renderer native`.
- **Blitz** ([DioxusLabs/blitz][dx-D1]) is a modular HTML/CSS engine. On `main` it uses:
  - Stylo, the Firefox and Servo style engine, from a DioxusLabs fork pinned by git revision;
  - Taffy for block, flex and grid layout, also pinned by git revision;
  - Parley for text, html5ever for HTML;
  - AnyRender for drawing, with Vello Hybrid on wgpu 30 as the default backend, and Vello,
    Vello CPU and Skia as options ([features][dx-D7], [workspace][dx-D59]);
  - winit `=0.31.0-beta.4`, AccessKit through its own `accesskit_xplat`, and rfd for dialogs.
- **Where the work is.** Development happens in the Blitz repository and is synced into Dioxus
  releases. Stable Dioxus 0.7.10 (2026-07-30) still ships Blitz 0.2, from October 2025. The
  engine being fixed today ships only in the 0.8 alphas (Blitz 0.3.0-beta.4) or from git.
- **Status in its own words.** Blitz's README: "currently in a **beta** state ... usable for
  making apps if you are an early adopter and willing to live on the bleeding edge" ([dx-D1]).
  The Dioxus 0.7 docs: "Dioxus Native is nascent", and "The Web and Webview renderers are the
  most mature engines while Dioxus-Native is still undergoing substantial improvements" ([dx-D58]).
  The 0.7 announcement: "We have not focused on performance" ([dx-D29]).

### Oriel's needs

Support: **Yes**, **Partial**, **DIY** (build it yourself on the framework), **No**.

| Need | Support | What exists | Evidence |
| --- | --- | --- | --- |
| 1. Gallery, 20k tiles | Partial | No virtual grid; build one on `onscroll` | [dx-D26], [dx-D33] |
| 1. Raw RGBA in | DIY | `<img>` decodes bytes; raw pixels need a `Widget` | [dx-D61], [dx-D9] |
| 1. GPU cache, eviction | No | Uploads never evicted; DOM cache unbounded | [dx-D10], [dx-D12] |
| 2. Video, overlay controls | DIY | No `<video>`; a `Widget` shows wgpu textures | [dx-D13], [dx-D8] |
| 3. Native menu bar | DIY | No muda integration; call muda directly | [dx-D7], [dx-D52] |
| 3. Transparent title bar | Partial | winit attributes; traffic-light inset via objc2 | [dx-D17] |
| 3. File dialogs | Yes | rfd, default `file-dialog` feature | [dx-D7] |
| 3. External file drop | Partial | Window-wide via `use_window_event` | [dx-D14], [dx-D16] |
| 3. Context menus, tooltips | Partial | `contextmenu` event; no `title` tooltips | [dx-D4], [dx-D57] |
| 3. Shortcuts and focus | Partial | keydown works; focus rings, Enter, Space broken | [dx-D18] |
| 3. Dock badge, progress | DIY | objc2 `NSDockTile`, as plan 063 does | none needed |
| 4. Table, 100k rows | Partial | Third-party libero only; a known panic | [dx-D36], [dx-D37] |
| 4. Tree, dialogs, toasts | Partial | libero; official kit uses JS `eval` | [dx-D33], [dx-D34] |
| 4. Menus, sliders, forms | Partial | No `<select>`, `<dialog>`, `<progress>` in Blitz | [dx-D3] |
| 5. HTML and CSS | Partial | Strong flex, grid, transitions; see below | [dx-D2], [dx-D5] |
| 6. Accessibility | Partial | AccessKit tree with ARIA names; AT actions ignored | [dx-D22], [dx-D21] |
| 6. IME, text | Partial | Preedit and commit; no composition events; macOS bugs | [dx-D23], [dx-D19] |
| 7. macOS arm64, Windows x64 | Partial | macOS is the main platform; Windows bugs | [dx-D56] |
| 8. Headless tests | Partial | `blitz-test-harness`, unpublished (`publish = false`) | [dx-D24] |
| 9. Maturity | Beta | Dioxus 0.8 alpha, Blitz 0.3 beta, no 1.0 date | [dx-D27], [dx-D6] |
| 10. Licence | Yes | MIT OR Apache-2.0; Stylo stack MPL-2.0 | [dx-D32] |
| 11. Agent-written port | Partial | React-like, Tailwind, hot reload; thin native docs | below |

Notes on the rows:

- **Gallery.** Dioxus's own `VirtualList` primitive measures the container with
  `document::eval`, which is JavaScript, so it does not run natively ([dx-D33]). Natively you get
  `onscroll`, `onmounted`, `get_scroll_offset`, `get_client_rect` and `scroll_to`, but
  `onresize`, drag, media and visibility events are `unimplemented!` ([dx-D26]); ResizeObserver
  and IntersectionObserver are not supported ([dx-D4]). The maintainer's plan for long lists is
  "a built-in `RecyclerView`-like widget", not yet built ([HN, 2026-01-12][dx-S7]). No benchmark of
  a large grid was found.
- **Raw images and the GPU.** An `<img>` loads through the net provider and is decoded by the
  `image` crate ([dx-D61]), so ImageIO's RGBA would have to be re-encoded, or drawn by a custom
  `Widget` that paints a `peniko::ImageData`. Either way, the default Vello Hybrid renderer
  uploads each image into its atlas once and keeps the id in a map that is only ever inserted
  into ([dx-D10]). Scrolling 20,000 thumbnails would keep every one on the GPU. The CPU renderer
  got a bounded cache in August ([dx-D11]); the GPU one has not. Blitz's DOM image cache also
  keeps every decoded image until a fix, [PR #1221][dx-D12], lands; it is open.
- **Menus and chrome.** The `dioxus-native` doc comment still lists a `menu` feature for muda,
  but neither 0.7.10 nor the 0.8 alphas have it ([dx-D52]). muda can still be driven directly.
  Transparent title bars come from winit's macOS window attributes; winit's traffic-light inset
  API is an open PR ([#4466][dx-D17]), so the inset needs objc2 code against the `NSWindow`.
- **Drag and drop.** `blitz-shell` drops `WindowEvent::DragDropped` on the floor ([dx-D14]).
  `use_window_event` receives raw winit events first ([dx-D15]), so the app can take dropped paths
  for the whole window and hit-test itself. DOM drag events are [PR #492][dx-D16], open.
- **Keyboard.** [#839][dx-D18] (open, 2026-09-07): ":focus-visible never matches, focus does not
  repaint, Enter/Space activate nothing". libero's wishlist repeats it ([dx-D39]).
- **Components.** The official `dioxus-components` (shadcn-style, over `dioxus-primitives`) are
  tested in webviews and browsers. Several primitives call `document::eval` ([dx-D33]); a native
  preview build and a calendar fix for native are open PRs ([dx-D34], [dx-D35]). The only kit found
  that targets Blitz is **libero** (tdymel/libero, 11 stars, 99 downloads): a Table with
  sorting, selection, virtual rows and tree rows, plus Tree, Menu, Modal, Slider and
  Notifications ([dx-D37]). Its CI skips 60 of 702 scenarios on macOS Blitz, including "a panic on
  a windowed table and a doubled Backspace" ([dx-D36]).
- **Accessibility.** On `main`, the tree maps `role`, `aria-label`, `aria-labelledby`,
  `aria-hidden`, `aria-expanded`, `aria-selected`, `aria-disabled` and `aria-level` ([dx-D22]), so
  VoiceOver could read Oriel's 103 `aria-label`s. Requests from assistive technology are a
  `// TODO` ([dx-D21]), so VoiceOver cannot press a button. The tracking issue still lists
  incremental updates and text input ([dx-D20]).
- **Text.** Parley shapes text; `apple-font-embolden` is on by default to approach macOS weight
  ([dx-D7]). On macOS, arrows move two characters and Cmd+arrow does nothing in inputs
  ([#894][dx-D19], open).
- **Platforms.** The maintainer benchmarks on an M1 Pro ([dx-S8]). Windows has an open
  local-asset deadlock bug (#958) and an unmerged fix for missed redraws (#601) ([dx-D56]).
  libero's CI runs Blitz on macOS and Windows, but on a windowless CPU renderer ([dx-D36]).
- **Testing.** `blitz-test-harness` drives a real `DioxusDocument` headless, with synthetic
  pointer, keyboard and IME input and PNG output through Vello CPU ([dx-D24]). It is not on
  crates.io, so it is a git dependency. A Devin "headless testing" skill is an open PR ([dx-D25]).
  There is no Chrome DevTools Protocol, so Playwright cannot drive it; devtools are a 1.0 item.

### HTML and CSS coverage

Blitz's support tables ([dx-D2], [dx-D3], [dx-D4]) and its WPT dashboard ([dx-D5]), on 2026-10-27:

| Feature | Blitz | Oriel uses it |
| --- | --- | --- |
| Flexbox | Supported; WPT css-flexbox 84.5% of tests | everywhere |
| Grid | Supported except subgrid; WPT 54.4% | `grid-cols-*`, 15 |
| `position: sticky` | In progress, open PR ([#887][dx-D54]) | `sticky`, 5 |
| `overflow: auto` | Listed unsupported; mapped to `scroll` in layout ([dx-D53]) | 8 |
| `text-overflow` | In progress, open PR ([#893][dx-D55]) | `truncate`, 91 |
| `line-clamp` | Not supported | 2 |
| 2D transforms | Supported; maintainer calls them "a bit buggy" ([dx-D40]) | yes |
| 3D transforms | Not supported | none found |
| Transitions, animations | Supported; WPT transitions 36.8% | yes |
| `box-shadow` | Supported | yes |
| `backdrop-filter` | Skia backend only; default Vello Hybrid has none | `backdrop-blur*`, 12 |
| `filter` | Skia; blur and drop-shadow only on Vello Hybrid | some |
| `text-shadow`, `mix-blend-mode` | Not supported | |
| `:hover` with `@media (hover: hover)` | Fixed 2026-07-03, Stylo 0.19 ([dx-D41]) | `hover:`, 89 |
| `:focus-visible` | Never matches ([dx-D18]) | 36 |
| `title` tooltips | Not shown ([dx-D57], open) | `title=`, 193 |
| `<dialog>`, `<select>`, `<video>` | Not supported | 2, 0, 6 |
| `<input type="range">` | Not in the tables | 2 |
| Container queries, `:has()` | Not supported; `:has()` off | 0 |

Oriel's counts come from a grep of `apps/oriel/src` (82 `.tsx` files) at `4c76020b`.

Overall, Blitz passes 52.65% of the WPT `css` suite's tests (18,620 of 35,359) ([dx-D5]). On
2026-09-02 the maintainer quoted 42.2% for Blitz on the `css` subset, against 50.3% for Servo
and 72.3% for Ladybird ([dx-S9]); that may be a different measure from the dashboard's.

**Tailwind 4 in practice.** `dx` runs the Tailwind CLI itself and handles v4 ([dx-D29]). Two
projects mapped a real Tailwind 4 app onto Blitz:

- **Kopuz**, a 1.95k-star music player, ran a spike on blitz-dom 0.2.4 in June 2026 ([dx-D42]).
  "all pages render and navigate", but four engine gaps hit "any Tailwind-styled app":
  - `display: contents` gave scrollers no scroll size;
  - `flex-1` and `min-h-full` gave no height in a block parent;
  - every `hover:` style was dropped by `@media (hover: hover)`;
  - `::file-selector-button` in Tailwind's preflight voided whole selector lists, so the reset
    did not apply.

  The author then fixed them upstream: Blitz #452 to #466 (six of eight merged), Taffy #965
  and anyrender #66. Their Stylo media-feature patch was closed; the hover fix arrived with
  Stylo 0.19 instead. `::file-selector-button` had landed in Stylo as servo/stylo#341 in
  March.
- **eq_ui**, a Tailwind component library, filed a gap analysis ([#389][dx-D40]). The
  maintainer's reply lists as "known not to be supported": `position:sticky`, `::placeholder`,
  `backdrop-filter` and scrollbar styling. Since then scrollbar styling is supported and
  `backdrop-filter` works on the Skia backend only.

**How close a port would be.**

- **Markup.** JSX to RSX is mechanical (`div { class: "...", onclick: ..., "text" }`).
  `dx translate` turns HTML into RSX. A JSX-style tag syntax for `rsx!` is an open PR by the
  maintainer ([#5730][dx-D51]). Class strings and `index.css` could mostly carry over.
- **Logic.** None of the TypeScript runs. React state, zustand stores, effects and
  `lucide-react` icons become Dioxus signals, stores, hooks and SVG. Oriel's
  `useVirtualGridMetrics.ts` becomes Rust that measures through `onmounted`.
- **CSS that needs a substitute or an engine fix:** `truncate` (91 uses), `title` tooltips
  (193), `focus-visible:` styles (36), backdrop blur (12) unless the Skia backend is used,
  `sticky` (5), `<dialog>`, range inputs and `<video>`.
- **The failure mode.** Unsupported CSS fails silently and can take neighbouring rules with
  it, as the hover and preflight cases did. Agents need a screenshot check, not only a build.

### Video and custom GPU content

- **No media elements.** `<video>` and `<audio>` are unchecked on the media tracking issue
  ([#259][dx-D13]). libero's Video component shows a fallback on Blitz: "Blitz plays no media"
  ([dx-D38]).
- **The custom widget API** (Blitz 0.3) is the way in ([dx-D9]).
  - A `Widget` receives the renderer's context, which downcasts to the wgpu `DeviceHandle`.
  - It registers a `wgpu::Texture` or `TextureView` with `try_register_custom_resource` and
    paints it as an image brush.
  - `requires_redraw()` keeps it repainting, and HTML is drawn both above and below it. The
    `wgpu_texture` example overlays a control panel on a spinning cube ([dx-D8]).
  - Since anyrender #110 (2026-10-02), Vello Hybrid treats external textures as ordinary image
    paints.
- **AVPlayer on macOS: plausible, unproven.**
  - Ask `AVPlayerItemVideoOutput` for BGRA, wrap each `CVPixelBuffer` as a `MTLTexture` with
    `CVMetalTextureCache`, import it through wgpu-hal's Metal `texture_from_raw` and
    `Device::create_texture_from_hal`, and register it.
  - That is zero-copy, but it is unsafe hal code tied to Blitz's exact wgpu version (30 on
    `main`), and nobody was found doing it.
  - The fallback is copying each frame with `queue.write_texture`.
  - GPUI's `surface()` already does this for Zed's call video.
- **Windows.** The same widget path with a D3D12 shared texture through wgpu-hal's DX12
  backend, also unproven, or a copy per frame.
- **What exists.** One two-star project, Nohac/weld, streams live frames into Dioxus Native
  through a custom widget, with a patched Vello Hybrid ([dx-D60]). An HN user says video was "a
  big blocker for me ... but i solved it myself", with no details ([dx-S10]).

### Adoption and activity

| Repository | Stars | Commits, 90 days | Authors, 90 days | Top author's share |
| --- | ---: | ---: | ---: | --- |
| DioxusLabs/dioxus | 39,519 | 71 | 19 | nicoburns 49 (69%) |
| DioxusLabs/blitz | 4,316 | 417 | 18 | nicoburns 387 (93%) |
| DioxusLabs/dioxus-components | 350 | 3 | 3 | none |

Bots excluded. Counts are commits on `main` by author date ([GitHub API][dx-D62]).

| Crate | Latest (stable) | Total downloads | 90 days | Reverse deps |
| --- | --- | ---: | ---: | ---: |
| `dioxus` | 0.8.0-alpha.3 (0.7.10) | 3,384,821 | 1,279,467 | 470 |
| `dioxus-desktop` | 0.8.0-alpha.3 (0.7.10) | 1,319,936 | 428,683 | 25 |
| `dioxus-native` | 0.8.0-alpha.3 (0.7.10) | 46,137 | 23,844 | 4 |
| `dioxus-native-dom` | 0.8.0-alpha.3 (0.7.10) | 179,701 | 27,089 | 4 |
| `blitz-dom` | 0.3.0-beta.4 (0.2.4) | 304,145 | 79,868 | 29 |
| `blitz-html` | 0.3.0-beta.4 (0.2.0) | 266,138 | 84,472 | 16 |
| `blitz-paint` | 0.3.0-beta.4 (0.2.1) | 127,257 | 76,309 | 13 |
| `blitz-shell` | 0.3.0-beta.4 (0.2.3) | 62,791 | 18,698 | 5 |
| `blitz-traits` | 0.3.0-beta.4 (0.2.0) | 255,199 | 95,398 | 26 |
| `blitz` | 0.3.0-beta.4 (0.2.1) | 2,406 | 742 | 0 |
| `anyrender` | 0.14.0 | 231,251 | 159,201 | 25 |
| `libero` | 0.5.0 | 99 | 81 | n/a |

For scale, the GPUI research recorded `gpui-kit` at 162,612 downloads in 30 days.

- **Releases and churn.**
  - Blitz 0.3 alphas and betas came every few days to seven weeks from April 2026. The roadmap
    estimated the 0.3 beta for August 2026; it is still in beta, and 1.0 has no date ([dx-D6]).
  - Dioxus 0.8.0-alpha.3 (2026-10-16) breaks custom renderers' `set_attribute`, moves keys to
    `Key::Named(NamedKey::...)`, and changes when native code sees DOM mutations ([dx-D27]).
  - Its known issues: "`dx components` doesn't work in this release".
- **Who uses it.** `dioxus-native`'s four reverse dependencies are two Bevy bridges, a log
  viewer and `dioxus` itself. GitHub code search finds "dioxus-native" in 202 `Cargo.toml`
  files across about 55 repositories. The largest:
  - OpenModelica (1,456 stars) builds an experimental `omshell_dioxus` beside its egui shell,
    natively "so the Help -> WebGPU test can composite a real wgpu scene" ([dx-D47]);
  - hush (47 stars).
- **Blitz's bigger users are not Dioxus Native apps** ([dx-D46]): Cloudflare's Kitesurf agent
  browser; Flectar Mail (1,662 stars), a Slint app that uses Blitz to render email HTML
  ([dx-D48]); fulgur (HTML to PDF).
- **No notable shipped desktop app on Dioxus Native was found.** Kopuz, the closest attempt,
  went to GPUI Kit instead (below).
- **Governance and funding.**
  - DioxusLabs raised $3.5M (Y Combinator S23, Khosla Ventures) and was supported by
    "Futurewei, Satellite.im, the GitHub Accelerator program" ([dx-D31], [dx-D30]). The brief's
    "FutureWear" is Futurewei; no other sponsor of that name was found.
  - On 2026-09-10 the team joined Cognition, the maker of Devin. "Our lead engineer on Blitz,
    Nico Burns, will be devoted full time to maintaining and improving Dioxus", and "we will be
    investing heavily in Dioxus-Native and Blitz" ([dx-D30]).
  - In practice one person wrote 93% of Blitz's commits in 90 days, much of it with Devin:
    there are `devin/*` branches, and Devin sessions are linked from PRs.

### Sentiment

Searched: HN through Algolia ("dioxus native", "blitz dioxus", "blitz renderer", "dioxus gpui",
and Dioxus comments since July 2025), Lobsters, GitHub issues, and blogs.

**Reddit was blocked.** `old.reddit.com/.../search.json` redirects to a login page (302), and
`api.reddit.com` and `www.reddit.com` return 403. Two r/rust threads were read through a
third-party mirror, `reddit.sentinel-team.org`; they are marked "mirror" below.

Count of independent voices since 2025-11 on Dioxus Native or Blitz as an app UI, one per
person:

| Position | Count |
| --- | ---: |
| Hopeful or watching, not shipping | 8 |
| Not ready, or ruled it out | 4 |
| Project tried it and left (Kopuz, to GPUI Kit) | 1 |
| Project building on it (libero; OpenModelica as an experiment) | 2 |

The eight hopeful: satvikpendem, dabinat, trueno, neobrain, hiccuphippo, polyglotfacto,
Aln76467 and jtesp. The four doubtful: tvshtr, radio, bobajeff and IshKebab.

Quotes, independent unless marked:

- **tvshtr**, HN, 2026-04-08 ([dx-S1]): GPUI would be their first choice, and "Dioxus native would
  be second, but it's far far far away from being ready."
- **satvikpendem**, HN, 2026-03-09 ([dx-S2]): "Only Dioxus with their native renderer might come
  close, but that's years away from being at a Flutter-level production capacity."
- **IshKebab**, HN, 2026-02-13 ([dx-S3]): for a table with 1 million rows, "The only Rust GUI
  library I found that could do this easily was gpui-component"; Dioxus was ruled out as
  web-based.
- **dabinat**, HN, 2026-06-13 ([dx-S4]): "It's still in early stages, but it's a lightweight web
  renderer with only the required pieces."
- **trueno**, HN, 2026-06-15 ([dx-S5]): Dioxus is "the front runner"; "if blitz works out thats
  going to be a very interesting new paradigm". No native toolkit has an ag-grid-class grid.
- **jtesp**, HN, 2026-03-10 ([dx-S10]): "a big blocker for me was video in blitz but i solved it
  myself."
- **bobajeff**, HN, 2026-05-17 ([dx-S11]): Blitz exposes no FFI, and "if you need anything
  interactive you have to use the dioxius framework".
- **radio**, Lobsters, 2025-11-25 ([dx-S12]): "I'm skeptical that they will be able to do it."
- **No-Associate2188**, r/rust (mirror), 2026-02-12 ([dx-S13]): "I like honestly GPUI Components
  the most."
- **Aln76467**, r/rust (mirror), 2026-01-26 ([dx-S14]), to a GPUI prototype: "Why not use blitz
  and boa instead of gpui and quickjs?"
- **nicoburns**, Blitz maintainer, HN, 2026-02-13 ([dx-S6]): "Dioxus Native, the non-webview
  version of Dioxus is also nearing readiness."
- **nicoburns**, Blitz maintainer and so a rival, r/rust (mirror), 2026-01-26 ([dx-S14]): "despite
  claims about being fast GPUI is actually currently relatively slow compared to most other
  Rust GUI frameworks".
- **jkelleyrtp**, Dioxus founder, blog, 2026-09-10 ([dx-D30]): "we will be investing heavily in
  Dioxus-Native and Blitz".

**Switches.** Kopuz is the one switch found, and it went towards GPUI Kit:

- The app was Dioxus Desktop with Tailwind. It tried Dioxus Native three times, and all three
  PRs were closed unmerged ([#394][dx-D42] on 2026-06-13, [#467][dx-D43] on 2026-08-16, [#635][dx-D44]
  on 2026-10-06).
- The spike was motivated by WebKitGTK's CPU rasterization on Linux ("~70fps ceiling").
- A GPUI Kit (`gpui-kit` 0.6.4) frontend became the main `kopuz` app, with the Dioxus app
  kept as "Kopuz Legacy" ([dx-D45], opened 2026-10-22, merged 2026-10-27). The PRs give no reason
  for dropping Blitz.

No project was found moving from GPUI to Dioxus Native.

**Dioxus generally** (not native): fasterthanlime, independent, 2025-11-22: "does Dioxus spark
joy? I'm gonna say: not yet", while noting the team is building "their own HTML and CSS
renderer" ([dx-S15]).

### Fit for an agent-written port

For:

- Agents know React, HTML and Tailwind well, and RSX is a short step from JSX.
- Hot reload is strong:
  - RSX templates reload live;
  - Subsecond hot-patches Rust function bodies, on by default from 0.8.0-alpha.0 ([dx-D63]);
  - native stylesheets hot-reload (0.7, #4830, [dx-D29]).
- Docs for agents:
  - `AGENTS.md` in the Dioxus repository, a contributor guide ([dx-D49]);
  - `llms.txt` and a 1.86 MB `llms-full.txt` for the 0.7 docs ([dx-D50]);
  - the maintainers' own agent skills (`.devin/skills/release-alpha`, [dx-D25]).

Against:

- The native docs are a few paragraphs ([dx-D58]), and they describe 0.7, while the native work
  that matters is on 0.8 alphas or git. Model knowledge of Dioxus 0.6 and 0.7 APIs will be out
  of date.
- Silent CSS failures need a visual check on every change. The headless harness's PNG output
  helps, but it is unpublished.
- No CDP, so Oriel's Playwright end-to-end suite cannot drive it.
- Debug builds are slow: libero warns "Blitz is unusably slow unoptimised" and sets
  `opt-level = 3` for dependencies ([dx-D36]).

### Verdict for Oriel

**Poor fit today.** The CSS head start is real but covers Oriel's easy parts. The hard parts
of plan 063 have no maintained answer on Dioxus Native:

- the gallery (no virtual grid, and GPU uploads that are never evicted);
- video under custom controls (no media, an unproven texture import);
- the 100k-row table (one tiny third-party kit, with a known panic);
- the menu bar and traffic lights;
- keyboard focus.

It stands on a beta engine whose stable line is a year old, written almost entirely by one
engineer. It could reach "fit with caveats" once Dioxus 0.8 and Blitz 0.3 are stable and image
eviction, sticky, `text-overflow`, drag and drop and a video widget have landed.

What choosing it would change in plan 063, compared with GPUI Kit:

1. **D1 and the pin.** Pin `dioxus-native` 0.8 alphas or a Blitz git revision, not a stable
   release. Expect breaking changes every alpha.
2. **Phase 0 gains STOP checks:**
   - a virtual grid with bounded GPU image memory, which means patching Vello Hybrid's cache or
     writing a tile-atlas widget;
   - AVPlayer frames through a custom `Widget` and wgpu-hal, in place of `surface()`;
   - muda menus, and objc2 traffic lights;
   - keyboard focus and activation.
3. **`crates/ui`.** No GPUI Kit equivalent. Adopt libero, or build a house kit, including the
   100k-row table, a tree, dialogs, a select and tooltips.
4. **The renderer port** keeps Tailwind classes and `index.css`. It replaces `truncate`,
   `title`, `focus-visible`, sticky, `<dialog>`, range inputs and `<video>`, and needs the Skia
   backend for backdrop blur.
5. **Tests.** The `blitz-test-harness` as a git dependency, or a home-made harness, in place of
   GPUI's test contexts. Playwright cannot drive the app.
6. **Accessibility in Phase 2.** VoiceOver reading names is plausible through `aria-label`;
   pressing controls from VoiceOver is not.
7. **Licence.** Shipped builds must point to the MPL-2.0 source of the Stylo crates.
8. **Risks.** Add the bus factor and the Cognition dependency to the STOP conditions.

### Sources

- **D1** Blitz README: <https://github.com/DioxusLabs/blitz/blob/main/README.md>
- **D2** Blitz CSS status: <https://blitz.is/status/css>
- **D3** Blitz HTML elements status: <https://blitz.is/status/elements>
- **D4** Blitz events status: <https://blitz.is/status/events>
- **D5** Blitz WPT css scores: <https://blitz.is/status/wpt/css>
- **D6** Blitz roadmap, #119: <https://github.com/DioxusLabs/blitz/issues/119>
- **D7** `dioxus-native` Cargo.toml and features:
  <https://github.com/DioxusLabs/blitz/blob/main/packages/dioxus-native/Cargo.toml>
- **D8** `wgpu_texture` example:
  <https://github.com/DioxusLabs/blitz/tree/main/examples/wgpu_texture>
- **D9** Custom `Widget` trait:
  <https://github.com/DioxusLabs/blitz/blob/main/packages/blitz-dom/src/node/custom_widget.rs>
- **D10** Vello Hybrid image upload cache, insert only:
  <https://github.com/DioxusLabs/anyrender/blob/main/crates/anyrender_vello_hybrid/src/scene.rs>
- **D11** anyrender #91, bounded cache for Vello CPU only:
  <https://github.com/DioxusLabs/anyrender/pull/91>
- **D12** Blitz PR #1221, evict unused images (open):
  <https://github.com/DioxusLabs/blitz/pull/1221>
- **D13** Blitz #259, images and media tracking: <https://github.com/DioxusLabs/blitz/issues/259>
- **D14** `blitz-shell` window events:
  <https://github.com/DioxusLabs/blitz/blob/main/packages/blitz-shell/src/window.rs>
- **D15** `use_window_event`:
  <https://github.com/DioxusLabs/blitz/blob/main/packages/dioxus-native/src/hooks.rs>
- **D16** Blitz PR #492, drag and drop (open): <https://github.com/DioxusLabs/blitz/pull/492>
- **D17** winit PR #4466, traffic-light inset (open):
  <https://github.com/rust-windowing/winit/pull/4466>
- **D18** Blitz #839, keyboard focus: <https://github.com/DioxusLabs/blitz/issues/839>
- **D19** Blitz #894, macOS text input: <https://github.com/DioxusLabs/blitz/issues/894>
- **D20** Blitz #262, accessibility tracking: <https://github.com/DioxusLabs/blitz/issues/262>
- **D21** AccessKit actions marked TODO:
  <https://github.com/DioxusLabs/blitz/blob/main/packages/blitz-shell/src/application.rs>
- **D22** Accessibility tree builder:
  <https://github.com/DioxusLabs/blitz/blob/main/packages/blitz-dom/src/accessibility.rs>
- **D23** Blitz PR #1086, composition events (open): <https://github.com/DioxusLabs/blitz/pull/1086>
- **D24** `blitz-test-harness`:
  <https://github.com/DioxusLabs/blitz/tree/main/packages/blitz-test-harness>
- **D25** Blitz PR #581, headless testing skill: <https://github.com/DioxusLabs/blitz/pull/581>
- **D26** Native event converters:
  <https://github.com/DioxusLabs/blitz/blob/main/packages/dioxus-native-dom/src/events.rs>
- **D27** Dioxus v0.8.0-alpha.3: <https://github.com/DioxusLabs/dioxus/releases/tag/v0.8.0-alpha.3>
- **D29** Dioxus v0.7.0 notes: <https://github.com/DioxusLabs/dioxus/releases/tag/v0.7.0>
- **D30** "Dioxus Labs is joining Cognition", 2026-09-10:
  <https://dioxuslabs.com/blog/joining-cognition/>
- **D31** Dioxus README, full-time team:
  <https://github.com/DioxusLabs/dioxus/blob/main/README.md>
- **D32** Blitz licensing review, 2026-10-07:
  <https://github.com/DioxusLabs/blitz/blob/main/docs/licensing.md>
- **D33** `dioxus-primitives` VirtualList, uses `document::eval`:
  <https://github.com/DioxusLabs/dioxus-components/blob/main/primitives/src/virtual_list.rs>
- **D34** dioxus-components PR #296, native preview (open):
  <https://github.com/DioxusLabs/dioxus-components/pull/296>
- **D35** dioxus-components PR #314, calendar on native (open):
  <https://github.com/DioxusLabs/dioxus-components/pull/314>
- **D36** libero getting started and CI matrix: <https://libero-ui.dev/md/getting_started.md>
- **D37** libero Table: <https://libero-ui.dev/md/table.md>
- **D38** libero Video: <https://libero-ui.dev/md/video.md>
- **D39** Blitz #1197, libero wishlist: <https://github.com/DioxusLabs/blitz/issues/1197>
- **D40** Blitz #389, eq_ui gap analysis: <https://github.com/DioxusLabs/blitz/issues/389>
- **D41** Blitz #252, `@media (hover)`: <https://github.com/DioxusLabs/blitz/issues/252>
- **D42** Kopuz PR #394, Blitz spike: <https://github.com/Kopuz-org/kopuz/pull/394>
- **D43** Kopuz PR #467, rebuild: <https://github.com/Kopuz-org/kopuz/pull/467>
- **D44** Kopuz PR #635, migration: <https://github.com/Kopuz-org/kopuz/pull/635>
- **D45** Kopuz PR #809, GPUI frontend: <https://github.com/Kopuz-org/kopuz/pull/809>
- **D46** Blitz #613, projects on Blitz: <https://github.com/DioxusLabs/blitz/issues/613>
- **D47** OpenModelica `omshell_dioxus`:
  <https://github.com/OpenModelica/OpenModelica/blob/master/OMCompiler/Compiler/OpenModelica.rs/omshell_dioxus/Cargo.toml>
- **D48** Flectar Mail, Slint and Blitz: <https://github.com/flectar/mail/blob/main/Cargo.toml>
- **D49** Dioxus `AGENTS.md`: <https://github.com/DioxusLabs/dioxus/blob/main/AGENTS.md>
- **D50** Dioxus 0.7 `llms.txt`: <https://dioxuslabs.com/learn/0.7/llms.txt>
- **D51** Dioxus PR #5730, JSX tag syntax (open): <https://github.com/DioxusLabs/dioxus/pull/5730>
- **D52** crates.io `dioxus-native` versions and features:
  <https://crates.io/api/v1/crates/dioxus-native>
- **D53** `overflow: auto` mapped to scroll:
  <https://github.com/DioxusLabs/blitz/blob/main/packages/stylo_taffy/src/convert.rs>
- **D54** Blitz PR #887, sticky (open): <https://github.com/DioxusLabs/blitz/issues/887>
- **D55** Blitz PR #893, text-overflow (open): <https://github.com/DioxusLabs/blitz/issues/893>
- **D56** Blitz Windows: PR #601 and issue #958: <https://github.com/DioxusLabs/blitz/issues/601>,
  <https://github.com/DioxusLabs/blitz/issues/958>
- **D57** Blitz PR #1259, `title` and `aria-describedby` (open):
  <https://github.com/DioxusLabs/blitz/pull/1259>
- **D58** Dioxus 0.7 `llms-full.txt`, "Dioxus Native is nascent":
  <https://dioxuslabs.com/learn/0.7/llms-full.txt>
- **D59** Blitz workspace Cargo.toml: <https://github.com/DioxusLabs/blitz/blob/main/Cargo.toml>
- **D60** Nohac/weld texture probe: <https://github.com/Nohac/weld>
- **D61** Blitz image loading:
  <https://github.com/DioxusLabs/blitz/blob/main/packages/blitz-dom/src/net.rs>
- **D62** GitHub commits API, for example:
  <https://api.github.com/repos/DioxusLabs/blitz/commits?since=2026-07-29T00:00:00Z>
- **D63** Dioxus v0.8.0-alpha.0: <https://github.com/DioxusLabs/dioxus/releases/tag/v0.8.0-alpha.0>
- **S1** tvshtr: <https://news.ycombinator.com/item?id=47684680>
- **S2** satvikpendem: <https://news.ycombinator.com/item?id=47317410>
- **S3** IshKebab: <https://news.ycombinator.com/item?id=47003586>
- **S4** dabinat: <https://news.ycombinator.com/item?id=48520321>
- **S5** trueno: <https://news.ycombinator.com/item?id=48535034>
- **S6** nicoburns: <https://news.ycombinator.com/item?id=47004171>
- **S7** nicoburns, virtual scrolling: <https://news.ycombinator.com/item?id=46587716>
- **S8** nicoburns, renderer backends on an M1 Pro: <https://news.ycombinator.com/item?id=46533928>
- **S9** nicoburns, WPT scores: <https://news.ycombinator.com/item?id=49530021>
- **S10** jtesp: <https://news.ycombinator.com/item?id=47319464>
- **S11** bobajeff: <https://news.ycombinator.com/item?id=48168806>
- **S12** radio on Lobsters: <https://lobste.rs/s/rdezfn/does_dioxus_spark_joy>
- **S13** r/rust "Tritium | Thanks for All the Frames", mirror:
  <https://reddit.sentinel-team.org/posts/1r2wc09/snapshots/2026-02-13T06%3A41%3A29.856984Z>
  (original <https://reddit.com/r/rust/comments/1r2wc09/>)
- **S14** r/rust "Driving Zed's GPUI with SolidJS", mirror:
  <https://reddit.sentinel-team.org/posts/1qncarj/snapshots/2026-01-27T02%3A50%3A36.127967Z>
  (original <https://reddit.com/r/rust/comments/1qncarj/>)
- **S15** fasterthanlime, "Does Dioxus spark joy?":
  <https://fasterthanli.me/articles/does-dioxus-spark-joy>

[dx-D1]: https://github.com/DioxusLabs/blitz/blob/main/README.md
[dx-D2]: https://blitz.is/status/css
[dx-D3]: https://blitz.is/status/elements
[dx-D4]: https://blitz.is/status/events
[dx-D5]: https://blitz.is/status/wpt/css
[dx-D6]: https://github.com/DioxusLabs/blitz/issues/119
[dx-D7]: https://github.com/DioxusLabs/blitz/blob/main/packages/dioxus-native/Cargo.toml
[dx-D8]: https://github.com/DioxusLabs/blitz/tree/main/examples/wgpu_texture
[dx-D9]: https://github.com/DioxusLabs/blitz/blob/main/packages/blitz-dom/src/node/custom_widget.rs
[dx-D10]: https://github.com/DioxusLabs/anyrender/blob/main/crates/anyrender_vello_hybrid/src/scene.rs
[dx-D11]: https://github.com/DioxusLabs/anyrender/pull/91
[dx-D12]: https://github.com/DioxusLabs/blitz/pull/1221
[dx-D13]: https://github.com/DioxusLabs/blitz/issues/259
[dx-D14]: https://github.com/DioxusLabs/blitz/blob/main/packages/blitz-shell/src/window.rs
[dx-D15]: https://github.com/DioxusLabs/blitz/blob/main/packages/dioxus-native/src/hooks.rs
[dx-D16]: https://github.com/DioxusLabs/blitz/pull/492
[dx-D17]: https://github.com/rust-windowing/winit/pull/4466
[dx-D18]: https://github.com/DioxusLabs/blitz/issues/839
[dx-D19]: https://github.com/DioxusLabs/blitz/issues/894
[dx-D20]: https://github.com/DioxusLabs/blitz/issues/262
[dx-D21]: https://github.com/DioxusLabs/blitz/blob/main/packages/blitz-shell/src/application.rs
[dx-D22]: https://github.com/DioxusLabs/blitz/blob/main/packages/blitz-dom/src/accessibility.rs
[dx-D23]: https://github.com/DioxusLabs/blitz/pull/1086
[dx-D24]: https://github.com/DioxusLabs/blitz/tree/main/packages/blitz-test-harness
[dx-D25]: https://github.com/DioxusLabs/blitz/pull/581
[dx-D26]: https://github.com/DioxusLabs/blitz/blob/main/packages/dioxus-native-dom/src/events.rs
[dx-D27]: https://github.com/DioxusLabs/dioxus/releases/tag/v0.8.0-alpha.3
[dx-D29]: https://github.com/DioxusLabs/dioxus/releases/tag/v0.7.0
[dx-D30]: https://dioxuslabs.com/blog/joining-cognition/
[dx-D31]: https://github.com/DioxusLabs/dioxus/blob/main/README.md
[dx-D32]: https://github.com/DioxusLabs/blitz/blob/main/docs/licensing.md
[dx-D33]: https://github.com/DioxusLabs/dioxus-components/blob/main/primitives/src/virtual_list.rs
[dx-D34]: https://github.com/DioxusLabs/dioxus-components/pull/296
[dx-D35]: https://github.com/DioxusLabs/dioxus-components/pull/314
[dx-D36]: https://libero-ui.dev/md/getting_started.md
[dx-D37]: https://libero-ui.dev/md/table.md
[dx-D38]: https://libero-ui.dev/md/video.md
[dx-D39]: https://github.com/DioxusLabs/blitz/issues/1197
[dx-D40]: https://github.com/DioxusLabs/blitz/issues/389
[dx-D41]: https://github.com/DioxusLabs/blitz/issues/252
[dx-D42]: https://github.com/Kopuz-org/kopuz/pull/394
[dx-D43]: https://github.com/Kopuz-org/kopuz/pull/467
[dx-D44]: https://github.com/Kopuz-org/kopuz/pull/635
[dx-D45]: https://github.com/Kopuz-org/kopuz/pull/809
[dx-D46]: https://github.com/DioxusLabs/blitz/issues/613
[dx-D47]: https://github.com/OpenModelica/OpenModelica/blob/master/OMCompiler/Compiler/OpenModelica.rs/omshell_dioxus/Cargo.toml
[dx-D48]: https://github.com/flectar/mail/blob/main/Cargo.toml
[dx-D49]: https://github.com/DioxusLabs/dioxus/blob/main/AGENTS.md
[dx-D50]: https://dioxuslabs.com/learn/0.7/llms.txt
[dx-D51]: https://github.com/DioxusLabs/dioxus/pull/5730
[dx-D52]: https://crates.io/api/v1/crates/dioxus-native
[dx-D53]: https://github.com/DioxusLabs/blitz/blob/main/packages/stylo_taffy/src/convert.rs
[dx-D54]: https://github.com/DioxusLabs/blitz/issues/887
[dx-D55]: https://github.com/DioxusLabs/blitz/issues/893
[dx-D56]: https://github.com/DioxusLabs/blitz/issues/601
[dx-D57]: https://github.com/DioxusLabs/blitz/pull/1259
[dx-D58]: https://dioxuslabs.com/learn/0.7/llms-full.txt
[dx-D59]: https://github.com/DioxusLabs/blitz/blob/main/Cargo.toml
[dx-D60]: https://github.com/Nohac/weld
[dx-D61]: https://github.com/DioxusLabs/blitz/blob/main/packages/blitz-dom/src/net.rs
[dx-D62]: https://api.github.com/repos/DioxusLabs/blitz/commits?since=2026-07-29T00:00:00Z
[dx-D63]: https://github.com/DioxusLabs/dioxus/releases/tag/v0.8.0-alpha.0
[dx-S1]: https://news.ycombinator.com/item?id=47684680
[dx-S2]: https://news.ycombinator.com/item?id=47317410
[dx-S3]: https://news.ycombinator.com/item?id=47003586
[dx-S4]: https://news.ycombinator.com/item?id=48520321
[dx-S5]: https://news.ycombinator.com/item?id=48535034
[dx-S6]: https://news.ycombinator.com/item?id=47004171
[dx-S7]: https://news.ycombinator.com/item?id=46587716
[dx-S8]: https://news.ycombinator.com/item?id=46533928
[dx-S9]: https://news.ycombinator.com/item?id=49530021
[dx-S10]: https://news.ycombinator.com/item?id=47319464
[dx-S11]: https://news.ycombinator.com/item?id=48168806
[dx-S12]: https://lobste.rs/s/rdezfn/does_dioxus_spark_joy
[dx-S13]: https://reddit.sentinel-team.org/posts/1r2wc09/snapshots/2026-02-13T06%3A41%3A29.856984Z
[dx-S14]: https://reddit.sentinel-team.org/posts/1qncarj/snapshots/2026-01-27T02%3A50%3A36.127967Z
[dx-S15]: https://fasterthanli.me/articles/does-dioxus-spark-joy

## Freya

### In one line

A Skia-drawn native toolkit with more built-in widgets than Dioxus Native, AccessKit and real
headless tests, but a one-person 0.x project that left Dioxus in July 2026, has no HTML or CSS,
no native menu bar and copies video frames: workable, with no edge over GPUI Kit for Oriel.

### What it is

- **marc2332/freya**, MIT. Since 0.4 (2026-07-16) it has "its own reactive and component model
  built from scratch". There is no Dioxus and no `rsx!`, only a typed builder API
  (`rect().width(Size::fill()).child(...)`) with hooks such as `use_state` ([dx-F2]).
- **Stack.** Torin (its own layout, not CSS), Skia through `freya-skia-safe` 0.104, winit 0.30,
  AccessKit 0.25.
- **Renderer backends** ([dx-F2]): macOS Metal; Windows OpenGL, then software; Linux Vulkan, then
  OpenGL.
- **Versions.** Stable 0.4.3 (2026-08-30). Release candidate 0.5.0-rc.13 (2026-10-25), with a
  new candidate about every week ([dx-F11]).

### Oriel's needs

| Need | Support | What exists | Evidence |
| --- | --- | --- | --- |
| 1. Gallery, 20k tiles | Partial | `VirtualScrollView`, rows of N tiles | [dx-F1], [dx-F2] |
| 1. Raw RGBA in, cache | Yes | `ImageHandle::from_rgba`; Skia GPU cache | [dx-F4], [dx-F2] |
| 2. Video, overlay controls | Partial | `freya-video`: ffmpeg process, frames copied | [dx-F3] |
| 2. External GPU textures | DIY | `RenderCallback` exposes the Skia canvas; undocumented | [dx-F15] |
| 3. Native menu bar | DIY | Tray icon only; muda by hand | [dx-F7] |
| 3. Title bar | Partial | Window-attributes hook; `titlebar` feature draws chrome | [dx-F7], [dx-F2] |
| 3. Dialogs, drop, menus | Yes | rfd; per-element `on_file_drop`; `ContextMenu` | [dx-F6], [dx-F2] |
| 3. Tooltips, shortcuts | Yes | `Tooltip`; keyboard focus navigation built in | [dx-F2] |
| 4. Table, 100k rows | Partial | `Table` plus a virtual, sortable example | [dx-F5] |
| 4. Other components | Partial | 45+ incl. Menu, Popup, Select, Slider, Sidebar; no tree | [dx-F2] |
| 5. HTML and CSS | No | Builder API; `freya-html` (Blitz) is for content only | [dx-F10] |
| 6. Accessibility, IME | Yes | AccessKit roles and focus; IME support | [dx-F2], [dx-F16] |
| 7. Platforms | Partial | macOS Metal; Windows on OpenGL | [dx-F2] |
| 8. Headless tests | Yes | `freya-testing`: input simulation, snapshots | [dx-F2] |
| 9. Maturity | 0.x | A full API rewrite in 0.4; 0.5 in release candidates | [dx-F11] |
| 10. Licence | Yes | MIT; `skia-safe` MIT over Skia's BSD-3; `ffmpeg-sidecar` MIT | [dx-F3] |
| 11. Agent-written port | Partial | `llms.txt`, a skill; no JSX or CSS reuse | [dx-F8], [dx-F9] |

- **Images.** `ImageViewer`'s asset cache drops an image after an age, one hour by default, once
  nothing uses it ([dx-F12]). No benchmark at 20,000 tiles was found.
- **Video.** `freya-video` pipes frames from ffmpeg (`ffmpeg-sidecar`) and plays sound through
  rodio ([dx-F3]). That is a CPU copy and an upload per frame, with A/V sync done by freya-video
  itself. Skia can
  wrap a Metal texture, so a zero-copy path is possible in principle, but Freya does not
  document one.

### Adoption and activity

| Item | Value |
| --- | --- |
| Stars, open issues | 3,276; 42 |
| Commits, 90 days | 337 by 7 humans; marc2332 wrote 326 (97%) |
| `freya` downloads | 47,178 total; 10,945 in 90 days; 12 reverse dependencies |
| `freya-testing` downloads | 21,450 total; 2,197 in 90 days |
| Apps | Maintainer's Valin (323 stars), marcterm, Sanctum; no notable others |
| Funding | GitHub Sponsors |

### Sentiment

- **Little discussion.** The HN "Freya 0.4" story got 18 points and one comment, asking for a
  comparison with other toolkits ([dx-F13]). Lobsters search found one comment on its thread
  ([dx-F14]).
- **The Blitz maintainer**, a rival, lists Freya among the "ones to watch" that "offer
  virtualized lists" ([dx-S6]).
- **Why it left Dioxus**, in the Freya maintainer's words: "Dioxus is primarily designed around
  web ... string-based attributes" ([dx-F2]).
- No comparisons with GPUI and no switches either way were found.

### Fit for an agent-written port

- **For.** There is an official `llms.txt` and a 1,007-line skill for agents ([dx-F8], [dx-F9]).
  Attributes are typed, so mistakes fail to compile. Hot reload works through Subsecond and
  `dx`, but is experimental.
- **Against.** The API changed completely in July 2026, so model knowledge is stale, and a
  React and Tailwind UI has to be rewritten, as with GPUI.

### Verdict for Oriel

**Fit with caveats, and no better than GPUI Kit.** Freya's headless testing is better, and it
has an MIT and Skia stack. Against GPUI Kit, it would change plan 063 in these ways:

- video copies ffmpeg frames, where GPUI on macOS uses `surface()` with zero copies;
- Windows runs on OpenGL;
- the menu bar is wired by hand with muda;
- the component set is smaller, with no tree or toasts;
- the project rests on one maintainer.

### Sources

- **F1** Freya README: <https://github.com/marc2332/freya>
- **F2** "Freya 0.4", 2026-07-16: <https://freyaui.dev/posts/0.4>
- **F3** `freya-video` Cargo.toml:
  <https://github.com/marc2332/freya/blob/main/crates/freya-video/Cargo.toml>
- **F4** Image element, `ImageHandle::from_rgba`:
  <https://github.com/marc2332/freya/blob/main/crates/freya-core/src/elements/image.rs>
- **F5** Virtual table example:
  <https://github.com/marc2332/freya/blob/main/examples/component_table_virtual.rs>
- **F6** File drop example:
  <https://github.com/marc2332/freya/blob/main/examples/feature_file_drop.rs>
- **F7** Window config, tray:
  <https://github.com/marc2332/freya/blob/main/crates/freya-winit/src/config.rs>
- **F8** Freya `llms.txt`: <https://freyaui.dev/llms.txt>
- **F9** Freya agent skill:
  <https://github.com/marc2332/freya/blob/main/plugins/freya/skills/freya/SKILL.md>
- **F10** PR #2157, `freya-html` on Blitz: <https://github.com/marc2332/freya/pull/2157>
- **F11** Releases: <https://github.com/marc2332/freya/releases>
- **F12** Asset cache:
  <https://github.com/marc2332/freya/blob/main/crates/freya-components/src/cache.rs>
- **F13** HN, "Freya 0.4": <https://news.ycombinator.com/item?id=48960435>
- **F14** Lobsters, "Freya 0.4": <https://lobste.rs/s/x3xvou/freya_0_4_rust_gui_library>
- **F15** Render callback example:
  <https://github.com/marc2332/freya/blob/main/examples/feature_render_callback.rs>
- **F16** IME handling:
  <https://github.com/marc2332/freya/blob/main/crates/freya-core/src/accessibility/ime.rs>

[dx-F1]: https://github.com/marc2332/freya
[dx-F2]: https://freyaui.dev/posts/0.4
[dx-F3]: https://github.com/marc2332/freya/blob/main/crates/freya-video/Cargo.toml
[dx-F4]: https://github.com/marc2332/freya/blob/main/crates/freya-core/src/elements/image.rs
[dx-F5]: https://github.com/marc2332/freya/blob/main/examples/component_table_virtual.rs
[dx-F6]: https://github.com/marc2332/freya/blob/main/examples/feature_file_drop.rs
[dx-F7]: https://github.com/marc2332/freya/blob/main/crates/freya-winit/src/config.rs
[dx-F8]: https://freyaui.dev/llms.txt
[dx-F9]: https://github.com/marc2332/freya/blob/main/plugins/freya/skills/freya/SKILL.md
[dx-F10]: https://github.com/marc2332/freya/pull/2157
[dx-F11]: https://github.com/marc2332/freya/releases
[dx-F12]: https://github.com/marc2332/freya/blob/main/crates/freya-components/src/cache.rs
[dx-F13]: https://news.ycombinator.com/item?id=48960435
[dx-F14]: https://lobste.rs/s/x3xvou/freya_0_4_rust_gui_library
[dx-F15]: https://github.com/marc2332/freya/blob/main/examples/feature_render_callback.rs
[dx-F16]: https://github.com/marc2332/freya/blob/main/crates/freya-core/src/accessibility/ime.rs

## Dioxus Desktop, for contrast

Dioxus Desktop runs the same RSX in the system webview through wry and tao: WKWebView on macOS
and WebView2 on Windows. It has full browser CSS, `<video>`, and muda menus. `dioxus-desktop`
had 428,683 downloads in 90 days, 18 times `dioxus-native`.

The owner wants no webview, so it is out. It matters here in two ways:

- One codebase can build for both renderers. Kopuz compiled both into one binary to compare
  them, and OpenModelica's front end builds for web, desktop and native.
- Kopuz tried Native because on Linux WebKitGTK "CPU-rasterizes the full viewport on every
  scroll frame" ([dx-D42]). It ended up on GPUI Kit, not Dioxus Native.
