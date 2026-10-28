# Which GPUI line to build Oriel GPUI on: what developers say and do

Research date: 2026-10-27

This research supports D1 in `docs/plans/063-oriel-gpui.md`. It covers three lines: A, GPUI Kit on
Zed's GPUI through `gpui-pre`, optionally with GPUI Fast; B, GPUI-CE with its port of GPUI Kit;
and C, upstream Zed GPUI used directly.

## Conclusion

The evidence supports the plan's recommendation, A, moderately strongly. It does not overturn it,
and two of the plan's arguments for B are weaker than the plan says.

- **What developers say.** Few independent developers compare A with B directly. Most comments
  compare GPUI with other Rust toolkits. Among independent voices found since the fork
  (2025-12-12), 12 favour GPUI Kit on Zed's GPUI, in words or by migrating to it, and 6 favour
  GPUI-CE. Another 8 raise concerns about Zed's GPUI as a library, 6 doubt CE, and 3 raise
  concerns about A. Nobody argued for using upstream with no kit and no snapshot.
- **What developers do.** In the last 30 days `gpui-pre` was downloaded 235,735 times and
  `gpui-ce` 10,964 times. The `gpui-kit` facade was downloaded 162,612 times and CE's
  `gpui_ce_components` 682 times. The largest shipped apps found are on A: Longbridge Pro, and
  BongoCat 2.0 (24.3k stars, rewritten on GPUI Kit, released 2026-09-28). The largest app found
  on CE is the Look launcher (1.2k stars). Migrations go both ways. Three projects moved from CE
  to A after CE yanked 0.3.x in August, and one moved from A to CE (work in progress). Several
  small projects that started on upstream git pins or other toolkits chose CE in October.
- **What CE's own maintainers say.** They describe the gaps themselves. One wrote "We don't
  currently have any documentation or guides". The publisher of the component port wrote that the
  port is "a pain to keep up to date". CE last merged Zed's upstream changes on 2026-09-03. Its
  component port is 224 GPUI Kit commits behind.

Two statements in plan 063 need correcting:

1. **Windows texture surfaces are not in any CE release.** CE's Windows wgpu renderer, which
   `SurfaceSource::Texture` needs on Windows, existed from 2026-06-24. CE's WGPU/WGSL migration
   ([#215](https://github.com/gpui-ce/gpui-ce/pull/215)) removed it on 2026-09-07, six days after
   [#121](https://github.com/gpui-ce/gpui-ce/pull/121) enabled surfaces on it. The published
   `gpui_ce_windows` 0.3.0 has no `wgpu` feature. The earlier `gpui_ce_windows` 0.1.0 had one,
   but the `gpui-ce` 0.2.2 it pairs with predates the `wgpu-surfaces` gate. The PR that restores it,
   [#313](https://github.com/gpui-ce/gpui-ce/pull/313), was opened 2026-10-03 and is still open.
   The plan's "on all three platforms" and "Choose B ... if Windows video needs CE's texture
   surfaces" rest on a pending PR, not on shipped code.
2. **CE's AI policy covers the core repository, not CE's port of GPUI Kit.** `gpui-ce/gpui-ce`
   forbids LLM-written contributions and instruction files. `gpui-ce/gpui-component` still has
   `AGENTS.md`, `CLAUDE.md` and `skills/`. Its publisher merged a 2,730-line PR on 2026-10-27
   whose description reads "implemented and reviewed with Codex"
   ([gpui-ce/gpui-component#6](https://github.com/gpui-ce/gpui-component/pull/6)). Fixes to CE's
   core would still have to stay local.

Evidence that would change the recommendation is listed under
[What would change the answer](#what-would-change-the-answer).

## Method and labels

GitHub was read through `gh api`: issues, PRs, discussions over GraphQL, commits, compare and code
search. crates.io was read through its API with a neutral User-Agent. Hacker News was read through
the Algolia API with typo tolerance off, from 2024-12-01. Lobsters was read through its search
pages. Blogs and the gpui-archipelago news pages were read with a web fetcher. The 90-day window
is 2026-07-27 to 2026-10-27.

Voices are labelled as follows:

- **Zed staff.** A public member of the `zed-industries` GitHub organization, or a GitHub profile
  that names the company.
- **Longbridge.** A public member of the `longbridge` GitHub organization.
- **CE maintainer.** A person who publishes CE's crates, merges CE PRs, or writes CE policy.
- **gpui-archipelago.** The group behind `gpui-unofficial`, a fourth line that republishes Zed's
  code. It is kept separate.
- **Independent.** Everyone else. A few independent developers also contribute to CE; they are
  marked as such.

Not reached:

- **Reddit.** It returned HTTP 403 to the JSON API and the web fetcher refused it. The r/rust
  thread "GPUI fork" (`1pl9lz0`, December 2025), linked from
  [gpui-kit#1798](https://github.com/longbridge/gpui-kit/discussions/1798), was not read.
- **Discord and X.** Not reachable. A Discord message by Mikayla Maki is known only through a
  Hacker News quotation.

## Sentiment by line

### A. GPUI Kit on Zed's GPUI (`gpui-pre`, GPUI Fast)

**Longbridge's own position.** Jason Lee (`huacnlee`) leads GPUI Kit and is the only crates.io
owner of `gpui-pre`, `gpui-kit`, `gpui-component` and `gpui-fast`.

- 2026-04-09, on forks and mirrors: "These projects just create problems without fixing them; I
  don't think it's worth wasting time on them."
  ([gpui-kit#2234](https://github.com/longbridge/gpui-kit/issues/2234#issuecomment-4210835228))
- Five months later Longbridge published Zed's GPUI itself, as weekly `gpui-pre` snapshots from
  2026-09-03. The gpui-archipelago news site, which is not neutral, says this followed Zed missing
  a deadline for an official release pipeline
  ([315-Day Vacuum](https://gpui-archipelago.github.io/news/315-day-vacuum/)). No primary source
  for that deadline was found.
- 2026-09-27, on native GPU surfaces for video: "This needs to go to upstream GPUI
  (zed-industries/zed) rather than into GPUI Kit." Also: "On Windows, `draw_surfaces` in the
  DirectX renderer is currently a no-op, and the wgpu renderer skips surfaces."
  ([gpui-kit#3168](https://github.com/longbridge/gpui-kit/issues/3168#issuecomment-5856755403))
  The `gpui-pre` crates carry no renderer patches by policy.
- 2026-09-13, on a `gpui-pre` crate that failed to build on stable Rust 1.97: "This caused by GPUI
  upstream, we can't fix it."
  ([gpui-kit#3054](https://github.com/longbridge/gpui-kit/issues/3054#issuecomment-5653247389))
- GPUI Fast's README: "The project remains experimental."
  ([longbridge/gpui-fast](https://github.com/longbridge/gpui-fast))
- On agents, 2026-09-26, answering a contributor who offered to reorganize the agent instructions:
  "You can just make changes."
  ([#3250](https://github.com/longbridge/gpui-kit/discussions/3250#discussioncomment-18613030))
  The repository ships `AGENTS.md`, `CLAUDE.md` and installable skills.

**Independent voices.** Most favourable comments about GPUI on Hacker News and Lobsters are about
GPUI Kit, under its old name gpui-component.

- IshKebab, 2026-02-13: "Definitely the best option today."
  ([HN](https://news.ycombinator.com/item?id=47003586)) The same person called it "the best Rust
  GUI option at the moment" on 2026-04-08
  ([HN](https://news.ycombinator.com/item?id=47689621)).
- nu11ptr, 2026-02-13, replying to a comment that GPUI had stalled: "It seems better than ever to
  me now that we have gpui-component." ([HN](https://news.ycombinator.com/item?id=47003110))
- hoistbypetard, 2026-08-22: "My current bet is on gpui-component to be that."
  ([Lobsters](https://lobste.rs/c/ntrxht))
- segphault, 2026-06-13: "I've been really impressed with GPUI, particularly with Longbridge's
  open source component library." ([HN](https://news.ycombinator.com/item?id=48516666))
- yicheng47 moved Runner from CE to `gpui-pre`, 2026-09-27. The reasons given: CE "is now a fork
  that diverges on purpose", and "a `gpui-ce` git rev (a diverging fork)" was considered and not
  chosen. The cost was named too: "a third-party publisher ... sole crates.io owner"
  ([runner#733](https://github.com/yicheng47/runner/issues/733)).
- jasonwun recorded an ADR on 2026-10-27: stay on `gpui-pre` and "revisit GPUI Fast once upstream
  no longer marks it experimental" ([Astrolabe#94](https://github.com/jasonwun/Astrolabe/pull/94)).
- Concerns about A. bayesnet (2026-04-29) worried that gpui-component borrows GPL code patterns
  from Zed ([HN](https://news.ycombinator.com/item?id=47951815)). Longbridge later added a licence
  audit to `gpui-pre` publishing
  ([gpui-kit#2936](https://github.com/longbridge/gpui-kit/pull/2936)). Haoxincode (2026-09-22)
  needs zero-copy video surfaces and keeps a `[patch.crates-io]` on the snapshot GPUI Kit pins
  ([gpui-kit#3168](https://github.com/longbridge/gpui-kit/issues/3168)).

### B. GPUI-CE and its port of GPUI Kit

**CE maintainers.** Miles Wirht (`philocalyst`) publishes CE's crates and merges PRs. Cameron
Campbell (`cameronpcampbell`) and Dustin Yost (`temportalflux`) write most of the code and the
policies.

- Cameron Campbell, 2026-09-26, in "The State of CE in 2026": "The gpui ecosystem is very
  fragmented at the moment." Also: "We don't currently have any documentation or guides". And on
  upstream syncs: "Ce currently merges changes from upstream gpui via an LLM."
  ([gpui-ce#318](https://github.com/gpui-ce/gpui-ce/discussions/318))
- Miles Wirht, 2026-10-02: "Hosting our own components work is one of our big roadblocks,
  especially with the current dominance of gpui-kit, which doesn't support us (we have our own
  fork, but I don't know most of the code and it's a pain to keep up to date)."
  ([gpui-ce#318](https://github.com/gpui-ce/gpui-ce/discussions/318#discussioncomment-18766145))
- Miles Wirht, 2026-10-24, asked whether CE will keep syncing with an upstream that uses LLMs:
  "We will pull upstream patches when appropriate"
  ([gpui-ce#318](https://github.com/gpui-ce/gpui-ce/discussions/318#discussioncomment-19167385)).
  The same day they gave CE's pitch: "We're the most feature complete GUI framework"
  ([comment](https://github.com/gpui-ce/gpui-ce/discussions/318#discussioncomment-19167708)).
- CE's README: "It's mostly API compatible with upstream, but that is changing!"
  ([gpui-ce](https://github.com/gpui-ce/gpui-ce))
- Dustin Yost, 2026-06-11, declining to read an LLM-drafted design: "I'm not interested in reading
  genAI outputs in the slightest"
  ([gpui-ce#38](https://github.com/gpui-ce/gpui-ce/discussions/38#discussioncomment-17265068)).
  The AI policy requires that "Only humans can be commit authors"
  ([AI_POLICY.md](https://github.com/gpui-ce/gpui-ce/blob/main/AI_POLICY.md)). Contributors must
  be vouched for, and PRs from people who are not are closed automatically
  ([CONTRIBUTING.md](https://github.com/gpui-ce/gpui-ce/blob/main/CONTRIBUTING.md)).
- CE recruits actively. Miles Wirht invited a Zed PR author to bring the change to CE
  ([zed#53475](https://github.com/zed-industries/zed/pull/53475#issuecomment-5198994867)). On
  2026-10-07 they opened "Switch to GPUI-CE" threads in two other projects
  ([gpuix#86](https://github.com/remorses/gpuix/issues/86),
  [zeron#827](https://github.com/zeronsh/zeron/issues/827)).

**CE's founder.** Nate Butler started CE and now publishes `gpui-unofficial`, a crates.io mirror
of Zed's GPUI. On 2026-02-13 they wrote: "I started the gpui-ce fork but I'm becoming somewhat
more interested in a fresh framework that is more aligned with the rust ecosystem in general"
([HN](https://news.ycombinator.com/item?id=47005761)). The two `gpui-ce` releases Nate Butler
published (0.3.2 and 0.3.3, December 2025) were yanked on 2026-08-28.

**Independent voices.**

- dlight, 2025-12-25, asked GPUI Kit for a CE feature flag. They also warned: "I don't see a
  project like this surviving if they don't pull any and every upstream improvements."
  ([gpui-kit#1856](https://github.com/longbridge/gpui-kit/discussions/1856))
- satvikpendem, 2026-02-13: "Sadly it doesn't actually look like gpui-ce has any activity"
  ([HN](https://news.ycombinator.com/item?id=47005527)). inanc-g said the same on 2026-03-13
  ([zed#50574](https://github.com/zed-industries/zed/issues/50574#issuecomment-4058025762)). Both
  comments predate CE's revival. CE's own commits rose from 5 in July to 66, 82 and 47 in August,
  September and October.
- cosoc, 2026-08-20, argued that GPUI Kit should "make a clean break and start over by depending
  directly on CE"
  ([#1856](https://github.com/longbridge/gpui-kit/discussions/1856#discussioncomment-18089676)).
  A day later the same person wrote, in Chinese: the community wants independence but has no one
  to lead it, component libraries will not risk a branch with an uncertain future, and the
  verdict is "no end in sight, choose carefully" (translated;
  [gpui-kit#2234](https://github.com/longbridge/gpui-kit/issues/2234#issuecomment-5363930166)).
- alecStewart1 moved Macros to CE on 2026-10-20 for people who "don't want to be completely at the
  whim of whatever the Zed team decide"
  ([macros#55](https://github.com/macros-app/macros/pull/55)). frostymur moved Aerofi from a Zed
  git pin to CE on 2026-10-18 so that "the framework versions independently of Zed's editor
  schedule" ([aerofi#48](https://github.com/frostymur/aerofi/pull/48)). kunkka19xx chose CE for
  the Look launcher because it is "under actively maintainence"
  ([look#544](https://github.com/kunkka19xx/look/issues/544)).
- quazardous is moving tvty from what they call "Longbridge's frozen snapshots of Zed's GPUI" to
  CE (2026-10-07, open). The move vendors two CE crates to carry fixes
  ([tvty#23](https://github.com/quazardous/tvty/pull/23)).
- Concerns borne out for users:
  - amirhossein-fzl, 2026-10-18: "The documentation and examples need to be updated. I couldn't
    even get the 'transition' example to run!!"
    ([gpui-ce#352](https://github.com/gpui-ce/gpui-ce/discussions/352#discussioncomment-19022401))
  - The 0.3.x yank broke the published `yororen_ui` crates. Their maintainer could not ship a fix
    "until upstream stabilizes" (translated;
    [yororen-ui#10](https://github.com/MeowLynxSea/yororen-ui/issues/10)).
  - Domen Kožar, a CE contributor, said on 2026-09-28 that two of their apps could not be
    released to crates.io because "gpui-ce release is missing"
    ([gpui-ce#319](https://github.com/gpui-ce/gpui-ce/discussions/319#discussioncomment-18766152)).
    CE 0.3.0 followed on 2026-10-20.

### C. Upstream Zed GPUI used directly

**Zed staff.**

- Mikayla Maki, 2025-12-12, closing outside GPUI PRs: "we're shifting focus to core product work
  at Zed, and without a Zed use case, I can't validate this code"
  ([zed#42905](https://github.com/zed-industries/zed/pull/42905#issuecomment-3647662949)). The
  same text closed five PRs within four seconds (#42905, #43655, #43822, #43848 and #44047, the
  last being Jason Lee's tray support).
- Mikayla Maki on Discord, quoted second-hand on HN: "GPUI develoment is getting some major brakes
  put on it." The quoted message adds that they were "also a maintainer" on CE
  ([HN](https://news.ycombinator.com/item?id=47003569)). Not verified at the source.
- Kirill Bulatov (`SomeoneToIgnore`; profile company `@zed-industries`), 2026-08-08, closing an
  Android backend PR: "such large PR won't be reviewed, unfortunately, but there's
  https://github.com/gpui-ce/gpui-ce and other forks that might be interested."
  ([zed#61057](https://github.com/zed-industries/zed/pull/61057#issuecomment-5226534269))
- dinocosta (Zed member), 2026-07-10: new public GPUI APIs need a discussion that maintainers have
  weighed in on first
  ([zed#60573](https://github.com/zed-industries/zed/pull/60573#issuecomment-4913842125)). Two
  such discussions on external GPU textures had no maintainer reply by the research date:
  [zed#60572](https://github.com/zed-industries/zed/discussions/60572) (opened 2026-07-08) and
  [zed#64849](https://github.com/zed-industries/zed/discussions/64849) (2026-09-28).
- Anthony Eid (profile company `@zed-industries`) merged an iOS backend on 2026-10-14. They called
  it "a side project for me outside working hours"
  ([zed#63068](https://github.com/zed-industries/zed/pull/63068#issuecomment-5641046495)). On
  2026-10-15 they said Longbridge's native window composition PR is "a feature that's pretty
  important" and that they would start reviewing it
  ([zed#62379](https://github.com/zed-industries/zed/pull/62379#issuecomment-6191332479)).
- Zed now requires a `[GPUI]` release-note line on every PR that touches `crates/gpui*`
  ([zed#64203](https://github.com/zed-industries/zed/pull/64203), merged 2026-09-15). No `gpui`
  release has followed. The last is still 0.2.2 (2025-10-22). Zed's README tells users to add
  `gpui_platform` from crates.io, but no crate of that name exists there
  ([README](https://github.com/zed-industries/zed/blob/main/crates/gpui/README.md)). The
  [gpui.rs](https://www.gpui.rs/) site says "For the near future, GPUI is tied to Zed."

**Independent voices.** The comments are about the library's status, not its code.

- Drew Miller (tritium.legal), 2026-02-12, describing GPUI as a framework "the Zed team has
  transparently, and understandably abandoned as an open source endeavour"
  ([blog](https://tritium.legal/blog/desktop)).
- Sha1rholder, 2026-08-12: "there's still no timeline in sight for GPUI to become a standalone
  project" ([HN](https://news.ycombinator.com/item?id=49277249)).
- atombender, 2026-02-13, on GPUI without a kit: "I tried gpui recently and I found it to be very,
  very immature." ([HN](https://news.ycombinator.com/item?id=47003543))
- tvshtr (2026-04-08) and Levitating (2026-08-09) complained that Zed rejects outside GPUI PRs
  ([HN](https://news.ycombinator.com/item?id=47684680), [Lobsters](https://lobste.rs/c/l5s8kr)).

### gpui-archipelago, the fourth line

John Yani (`Vanuan`) co-owns `gpui-unofficial`. On 2026-09-04 they wrote that GPUI's thin core
"create conditions for extreme fragmentation that is only comparable to Web Browser wars"
([HN](https://news.ycombinator.com/item?id=49569760)). The crates.io registry agrees. Besides
Zed's own crate, at least 16 copies or forks of GPUI are published there:

- `gpui-pre`, `gpui-fast`, `gpui-ce` and `gpui-unofficial`;
- `gpui-standalone`, `bezel-gpui`, `bite-gpui`, `open-gpui`, `adabraka-gpui`, `boltz-gpui`,
  `fc-gpui`, `gpui_rn`, `mhr-gpui`, `fanta-gpui-core`, `gpui-x` and `wgpui`.

Tools now exist that only resolve between forks (`gocar-gpui`, "targets any gpui fork crate").

### The count

These are the independent voices found since 2025-12-12 that state a view or act on one. Each
person is counted once per column. The evidence is thin: CE comes up in 8 Hacker News comments in
total.

| Position | Count | Who |
| --- | ---: | --- |
| Favours GPUI Kit on Zed's GPUI (A or its predecessor) | 12 | 8 commenters, 4 project decisions |
| Favours GPUI-CE (B) | 6 | cosoc, Quick-Flash, and 4 projects that moved to CE |
| Hopes CE works out, no choice made | 2 | Levitating, hojberg |
| Favours plain upstream with no kit or snapshot (C) | 0 | none |
| Concern about Zed's GPUI as a library | 8 | Miller, satvikpendem, Sha1rholder, atombender, and others |
| Doubt or concern about CE | 6 | dlight, satvikpendem, jenadine, inanc-g, amirhossein-fzl, znicelya |
| Concern about A | 3 | bayesnet, landr0id, Haoxincode |
| Uses both lines | 1 | Domen Kožar (Agentaps on GPUI Kit, Factorseal on CE) |

The 8 commenters are nu11ptr, IshKebab, h4ch1, foresto, segphault, victor106, ellg and
hoistbypetard. The project decisions for A are Runner, DBFlux and dtrpg, which moved to it, and
Astrolabe, whose ADR stays on it. The projects that moved to CE are tvty, Aerofi, Macros and
Look.

Many of the comments favouring GPUI Kit predate `gpui-pre` and never mention CE. They show the
kit's reputation, not a comparison with B. The views favouring CE are recent (August to October
2026), come from small projects, and give independence from Zed as the reason.

## Adoption

### crates.io

Read 2026-10-27. "90 days" is crates.io's `recent_downloads`. "30 days" sums the daily download
endpoint from 2026-09-27. Third-party reverse dependencies exclude a line's own sub-crates.
Download counts include CI, and they double count within a line, because one GPUI Kit build fetches
`gpui-pre`, `gpui-component` and `gpui-kit`. Compare like with like: snapshot with fork, facade
with facade.

| Crate | Line | Latest | Total downloads | 90 days | 30 days | Third-party dependents | Releases in 90 days | Owners |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| [`gpui`](https://crates.io/crates/gpui) | C | 0.2.2, 2025-10-22 | 404,454 | 228,263 | 99,514 | 134 | 0 | Zed (3 people, a team) |
| [`gpui-pre`](https://crates.io/crates/gpui-pre) | A | 0.3.10, 2026-10-26 | 281,084 | 281,084 | 235,735 | 85 | 11 | huacnlee |
| [`gpui-kit`](https://crates.io/crates/gpui-kit) | A | 0.8.1, 2026-10-26 | 187,625 | 187,625 | 162,612 | 60 | 13 | huacnlee |
| [`gpui-component`](https://crates.io/crates/gpui-component) | A | 0.8.1, 2026-10-26 | 359,135 | 284,203 | 214,523 | 23 | 12 | huacnlee |
| [`gpui-fast`](https://crates.io/crates/gpui-fast) | A | 0.1.12, 2026-10-26 | 50,334 | 50,334 | 50,334 | 9 | 13 | huacnlee |
| [`gpui-ce`](https://crates.io/crates/gpui-ce) | B | 0.3.0, 2026-10-20 | 21,853 | 19,319 | 10,964 | 19 | 2, and 2 yanked | philocalyst |
| [`gpui_ce_components`](https://crates.io/crates/gpui_ce_components) | B | 0.2.0, 2026-08-29 | 772 | 772 | 682 | 2 | 1 | philocalyst |
| [`gpui-unofficial`](https://crates.io/crates/gpui-unofficial) | mirror | 1.25.3, 2026-10-23 | 11,118 | 8,971 | 5,031 | 18 | 34 | iamnbutler, Vanuan, a team |

`gpui`'s 90-day downloads mostly come from projects still pinned to GPUI Kit 0.5.x and other
crates frozen on 0.2.2. All of its latest dependents depend on a release that is a year old.

GitHub code search finds the following numbers of `Cargo.toml` files that mention each name.
GitHub's counts are approximate.

| Name | Files |
| --- | ---: |
| `gpui-kit` | 1,940 |
| `gpui-component` | 1,960 |
| `gpui-pre` | 1,070 |
| `gpui-ce` | 319 |
| `gpui-fast` | 212 |
| `gpui_ce_components` | 28 |
| `"gpui-ce/gpui-component"` | 2 |

### Repository activity, 2026-07-27 to 2026-10-27

| Repository | Commits | Distinct authors | Concentration | Last upstream sync |
| --- | ---: | ---: | --- | --- |
| Zed, `crates/gpui` and its platform crates | 228 | 80 | spread across Zed staff | not applicable |
| `longbridge/gpui-kit` | 746 | 124 | huacnlee and madcodelife: 395 (53%) | `gpui-pre` 0.3.10 = `zed@08cbb88`, 2026-10-25 |
| `longbridge/gpui-fast` | 256, including upstream merges | 57 | 134 by Longbridge-side authors | `zed@08cbb88`, 2026-10-25 |
| `gpui-ce/gpui-ce`, CE's own commits | 200 | 24 | three maintainers: 168 (84%) | 2026-09-03 ([#219](https://github.com/gpui-ce/gpui-ce/pull/219)) |
| `gpui-ce/gpui-component` | 83 own since the fork | about 3 | philocalyst and domenkozar | GPUI Kit at 2026-09-30, now 224 commits behind |

Notes on the table:

- **Zed since CE's sync.** Zed has landed 131 commits on its GPUI crates since CE's last upstream
  sync.
- **CE's history.** CE's history also contains GPUI Kit's history. It absorbed the kit as a
  subtree on 2026-08-27, before splitting it out, so the CE row counts only commits not found in
  GPUI Kit.
- **Merged PRs.** CE merged 98 PRs in the window. Cameron Campbell and Dustin Yost wrote 60 of
  them.
- **PR backlog.** 7 of CE's 19 open PRs are older than 21 days, including Windows wgpu #313. For
  GPUI Kit it is 1 of 22, and for GPUI Fast 0 of 7.
- **Issue response.** Outsiders opened 237 issues on GPUI Kit in the window, and 154 are closed.
  The 73 that drew a Longbridge reply got it after a median of 49 hours. CE routes user reports
  through GitHub Discussions, and it has only 19 discussions since 2026-06-06. Of its 108 issues
  in the window, 80 were one person's tracker for another project, filed and closed on 2026-09-01.
  So CE's response time cannot be compared with the kit's.

### Notable apps

Apps with published releases, not demos. Star counts and release counts are from GitHub on the
research date.

- **A.**
  - Longbridge Pro, a commercial trading app, the kit's driver.
  - [BongoCat](https://github.com/ayangweb/BongoCat), 24.3k stars. Version 2.0.0 (2026-09-28)
    "uses a new native Rust architecture" on GPUI Kit, and it ships Windows builds.
  - [Zedis](https://github.com/vicanso/zedis), 2.2k stars, 49 releases.
  - [Navop](https://github.com/feigeCode/navop), 2.0k stars, 59 releases, on GPUI Fast.
  - [DBFlux](https://github.com/0xErwin1/dbflux), 490 stars.
  - [Runner](https://github.com/yicheng47/runner), 405 stars, 100 or more releases.
- **B.**
  - [Look](https://github.com/kunkka19xx/look), 1.2k stars, 67 releases, packaged in nixpkgs.
    Its GPUI shell runs on CE.
  - [Aerofi](https://github.com/frostymur/aerofi), 21 stars, 41 releases. It moved to CE on
    2026-10-18, after its latest release.
  - Cachix's [Factorseal](https://github.com/cachix/factorseal) (80 stars) is on CE but has no
    release yet.
- **C directly.** Zed. Most other apps on Zed git pins found during this research had moved to
  `gpui-pre` or to CE.
- **Mirror.** [Hummingbird](https://github.com/hummingbird-player/hummingbird), a music player
  with 620 stars, depends on `gpui-unofficial`. The author of CE's 2026-09-03 upstream sync
  ([#219](https://github.com/gpui-ce/gpui-ce/pull/219)) reported testing it in Hummingbird.

### Migrations

Explicit moves found in September and October 2026:

- **CE to A: 3.** [Runner](https://github.com/yicheng47/runner/issues/733),
  [Agentaps](https://github.com/cachix/agentaps/pull/5) (Domen Kožar), and
  [dtrpg](https://github.com/pilgrimagesoftware/dtrpg/pull/16), whose CE plan was archived "as
  superseded, since the app migrated to `gpui-kit`".
- **A to CE: 1.** [tvty](https://github.com/quazardous/tvty/pull/23), work in progress.
- **Upstream pins or crates.io `gpui` 0.2.2 to A.** At least 8, including DBFlux, Fulgur, Argand,
  Markturbo, Huterm, Ekubo's wallet and `tauri-plugin-gpui`.
- **Upstream pins, vendored GPUI or other toolkits to CE.** At least 7: Aerofi, Macros, Look,
  Capsule, Cephalon, Alpenglow and Crepuscularity. A fork of `gpui-video-player` was also ported
  to CE ([PR](https://github.com/Airradda/gpui-video-player/pull/7)). The original
  [`gpui-video-player`](https://github.com/cijiugechu/gpui-video-player), the one Jason Lee points
  video questions to, supports `gpui` 0.2 and `gpui-pre`.

The pattern: Runner, which had shipped on CE's December snapshot, left when the 0.3.x yank broke
re-resolution. Agentaps and dtrpg left without giving a reason. New, small projects that want
independence from Zed are arriving at CE.

## Concerns, and whether the repositories bear them out

| Concern | A: GPUI Kit on `gpui-pre` (and Fast) | B: GPUI-CE and its kit port | C: upstream directly |
| --- | --- | --- | --- |
| Bus factor | Borne out on crates.io: one owner for all four crates. Code is less concentrated: 124 authors, 53% from two Longbridge staff. | Borne out: one crates.io owner, three people write 84% of commits, volunteers. | Not a risk for the code: 80 authors, Zed staff. It is a risk for releases: none in a year. |
| API churn | Borne out: weekly snapshots of Zed `main`, not of Zed releases, and 3 minor kit versions in 8 weeks. Breakages: `font-kit` silently off in 0.3.7, so no text ([#3337](https://github.com/longbridge/gpui-kit/issues/3337)); newest Rust required ([#3054](https://github.com/longbridge/gpui-kit/issues/3054)); a BongoCat PR for 0.8.1 had to raise its toolchain, because `gpui-pre` 0.3.10 uses an API stabilized in Rust 1.98 ([#1190](https://github.com/ayangweb/BongoCat/pull/1190), closed unmerged). | Borne out, and worse: 0.3.x yanked and the version line reset to 0.2.2; the 0.3.0 changelog lists AppContext, colour, length, asset and text-system breaks on purpose. | Same code as A, but through git pins with no versions. |
| Fragmentation | Kit and snapshot stay on Zed's types. | CE diverges on purpose. Its kit port lags 224 commits and dropped features (shell, touch selection, data icons). | Zed's README points at a `gpui_platform` crate that does not exist. |
| Windows and Linux quality | Inherits upstream: Zed's issue tracker has open Wayland and Win32 bugs reported through `gpui-pre`. | Inherits upstream as of 2026-09-03, plus CE's own Wayland issues. | Same as A. |
| Accessibility | AccessKit upstream. The same scrolled-out click bug is open on both lines ([kit#3658](https://github.com/longbridge/gpui-kit/issues/3658), [ce#282](https://github.com/gpui-ce/gpui-ce/issues/282)). | AccessKit in `gpui-ce` 0.3.0. | Same as A. |
| Documentation | Docs site, a story gallery, and skills for agents. Independent comments praise it. | Borne out: "We don't currently have any documentation or guides" (maintainer), and examples do not run (user). | README and examples only. Users report "read the code for docs" ([HN](https://news.ycombinator.com/item?id=48001979)). |
| AI policy | Friendly: agent instructions and skills in the repository. | Core forbids LLM-written commits and prose. The kit port does not enforce this yet. | Zed staff write PRs with agents ("agnatically created", [zed#63068](https://github.com/zed-industries/zed/pull/63068#issuecomment-5420946957)). |
| Outside features accepted | Longbridge says renderer work must go upstream. GPUI Fast takes it as an experiment. | Yes, this is CE's reason to exist. Review bandwidth is the limit: #313 has been open 3.5 weeks. | Rarely: five PRs closed at once in December, and no maintainer reply on the GPU texture discussions. |

## Fit for Oriel GPUI

The plan's needs are: written mostly by agents, macOS first, Windows later, custom video
rendering, and a long-lived app.

**Written mostly by agents.** This favours A and weighs against B's core.

- GPUI Kit ships skills and agent instructions, and its lead accepts agent-related changes.
- Zed's own staff build GPUI features with agents.
- Under B, any fix to CE's core made by an agent cannot go upstream, so it becomes a local
  patch on a fork that already diverges. CE's kit port accepts AI-assisted PRs for now. Most of
  the video and platform work would touch the core, not the kit.

**macOS video, AVPlayer to CVPixelBuffer.** No difference between the lines for Phase 0, with a
slight edge to A.

- `gpui::surface()` / `paint_surface` takes a `CVPixelBuffer` on Metal upstream. Jason Lee names
  it as the macOS path
  ([gpui-kit#3168](https://github.com/longbridge/gpui-kit/issues/3168#issuecomment-5856755403)).
- CE keeps Metal as the default renderer, with wgpu opt-in, so it has the same path as of its
  September sync.
- Under A the path is the one Zed uses for call video, and it stays current with Zed.

**Windows video, Phase 8.** No line has a released zero-copy path today.

| Line | GPU texture or surface | Per-frame image | Native composition under GPUI |
| --- | --- | --- | --- |
| A, `gpui-pre` | No. The DirectX `draw_surfaces` is a no-op, and wgpu skips surfaces. | Yes, a `RenderImage` per frame, which is Zed's own path. It churns the sprite atlas. | No. It is upstream PR [zed#62379](https://github.com/zed-industries/zed/pull/62379), open; a Zed engineer said on 2026-10-15 they would review it. |
| A, with GPUI Fast | Not zero-copy. A dynamic BGRA texture API for streaming frames is open ([gpui-fast#86](https://github.com/longbridge/gpui-fast/pull/86), 2026-10-26). | Yes. | Yes, experimental: native content composed under GPUI overlays on Windows (WebView2 composition) and macOS. |
| B, `gpui-ce` 0.3.0 | No released path. Windows wgpu was removed 2026-09-07; restoring it is [#313](https://github.com/gpui-ce/gpui-ce/pull/313), open. | Yes. | No. |
| C | Same as `gpui-pre`. | Yes. | Same as `gpui-pre`. |

So the Windows argument for B is, at best, a bet on #313 landing. Under A there are three routes:

- per-frame images;
- GPUI Fast's dynamic textures, if #86 lands;
- composing a native Media Foundation video surface under GPUI. This last route is plausible
  but untested here.

A fourth route is the one Haoxincode already uses: keep a D3D11 surface patch pinned to the
snapshot GPUI Kit uses.

**A long-lived app.** This favours A, with a cheap exit to C.

- A is driven by a shipped commercial product.
- A tracks Zed within days.
- A's snapshots name the Zed commit they come from. Runner's ADR notes that "a Zed git dependency
  at the commit a snapshot names is the same code", so leaving `gpui-pre` for C is mechanical.
- Leaving CE for either line means undoing deliberate API changes. Runner, Agentaps and dtrpg
  each took on such a port.
- The real risk under A is that one person publishes the crates. The real risks under B are three
  volunteers and a component port its own publisher calls hard to keep current.

### What would change the answer

- **CE ships Windows texture surfaces and A's routes fail.** Specifically: CE merges #313 and
  releases it, Phase 8 measures per-frame upload on A as too slow for Duplicates' several
  players, and neither GPUI Fast's #86 nor native composition works. Then B's Windows case becomes
  real. A pinned surface patch on A would still be worth costing first.
- **Longbridge's cadence breaks.** If no `gpui-pre` snapshot appears for more than about four
  weeks, or the kit stalls, move to C at the last snapshot's Zed commit.
- **Zed publishes `gpui` to crates.io again with its `[GPUI]` release notes.** Then C becomes a
  first-class option, and A converges with it.
- **CE grows.** CE's kit port would need to stay within a few weeks of GPUI Kit, CE would need
  documentation, and the share of commits from its top three people would need to fall clearly
  below 84%. Then B becomes a real alternative for a long-lived app.
- **Zed engages with outside GPU-surface work.** If Zed reviews #62379 or the
  [zed#64849](https://github.com/zed-industries/zed/discussions/64849) surface proposal, A and C
  both improve.

## Not established

- Reddit, Discord and X could not be read. The Discord message attributed to Mikayla Maki is
  second-hand.
- gpui-archipelago reports that Zed promised a crates.io release pipeline by the end of September
  2026, after an ultimatum from Jason Lee. No primary source was found in Zed's or Longbridge's
  repositories.
- Whether GPUI Fast's native composition can host an `AVPlayerLayer`, or a Media Foundation
  swapchain on Windows, was not tested.
- Whether CE's macOS `surface()` behaves like upstream after CE's Parley and `Background` changes
  was not tested.
- The affiliation of Sunli (`sunli829`), GPUI Fast's main author, with Longbridge is not shown
  publicly.
- Download counts and code-search counts are noisy, and they measure fetches and files, not
  users.
- Only issues and PRs that mention the lines by name were searched, so projects that adopted a
  line silently are missed.

## Sources

- Zed:
  - GPUI README:
    <https://github.com/zed-industries/zed/blob/main/crates/gpui/README.md>
  - <https://www.gpui.rs/>
  - The closed PRs: <https://github.com/zed-industries/zed/pull/42905#issuecomment-3647662949>
    and #43655, #43822, #43848, #44047
  - <https://github.com/zed-industries/zed/pull/61057#issuecomment-5226534269>
  - <https://github.com/zed-industries/zed/pull/60573#issuecomment-4913842125>
  - <https://github.com/zed-industries/zed/discussions/60572>
  - <https://github.com/zed-industries/zed/discussions/64849>
  - <https://github.com/zed-industries/zed/pull/63068>
  - <https://github.com/zed-industries/zed/pull/62379>
  - <https://github.com/zed-industries/zed/pull/64203>
  - <https://github.com/zed-industries/zed/issues/50574#issuecomment-4058025762>
- GPUI Kit and GPUI Fast:
  - <https://github.com/longbridge/gpui-kit>
  - <https://github.com/longbridge/gpui-kit/discussions/1856>
  - <https://github.com/longbridge/gpui-kit/discussions/1798>
  - <https://github.com/longbridge/gpui-kit/issues/2234>
  - <https://github.com/longbridge/gpui-kit/issues/3168>
  - <https://github.com/longbridge/gpui-kit/issues/3054>
  - <https://github.com/longbridge/gpui-kit/issues/3337>
  - <https://github.com/longbridge/gpui-kit/issues/3658>
  - <https://github.com/longbridge/gpui-kit/discussions/3250>
  - <https://github.com/longbridge/gpui-kit/pull/2936>
  - <https://github.com/longbridge/gpui-fast>
  - <https://github.com/longbridge/gpui-fast/pull/86>
- GPUI-CE:
  - <https://github.com/gpui-ce/gpui-ce>, with
    [AI_POLICY.md](https://github.com/gpui-ce/gpui-ce/blob/main/AI_POLICY.md) and
    [CONTRIBUTING.md](https://github.com/gpui-ce/gpui-ce/blob/main/CONTRIBUTING.md)
  - Discussions: <https://github.com/gpui-ce/gpui-ce/discussions/318>,
    <https://github.com/gpui-ce/gpui-ce/discussions/319>,
    <https://github.com/gpui-ce/gpui-ce/discussions/38>,
    <https://github.com/gpui-ce/gpui-ce/discussions/352>
  - PRs: <https://github.com/gpui-ce/gpui-ce/pull/121>,
    <https://github.com/gpui-ce/gpui-ce/pull/215>,
    <https://github.com/gpui-ce/gpui-ce/pull/219>,
    <https://github.com/gpui-ce/gpui-ce/pull/313>
  - <https://github.com/gpui-ce/gpui-ce/issues/282>
  - <https://github.com/gpui-ce/gpui-component>,
    <https://github.com/gpui-ce/gpui-component/pull/6>
- crates.io API: `/api/v1/crates/{name}`, with `/downloads`, `/reverse_dependencies` and
  `/owners`, for `gpui`, `gpui-pre`, `gpui-kit`, `gpui-component`, `gpui-fast`, `gpui-ce`,
  `gpui_ce_components`, `gpui_ce_windows` and `gpui-unofficial`
- Hacker News:
  - <https://news.ycombinator.com/item?id=47003110>
  - <https://news.ycombinator.com/item?id=47003543>
  - <https://news.ycombinator.com/item?id=47003569>
  - <https://news.ycombinator.com/item?id=47003586>
  - <https://news.ycombinator.com/item?id=47005527>
  - <https://news.ycombinator.com/item?id=47005761>
  - <https://news.ycombinator.com/item?id=47240463>
  - <https://news.ycombinator.com/item?id=47684680>
  - <https://news.ycombinator.com/item?id=47689621>
  - <https://news.ycombinator.com/item?id=47689957>
  - <https://news.ycombinator.com/item?id=47690239>
  - <https://news.ycombinator.com/item?id=47951613>
  - <https://news.ycombinator.com/item?id=47951815>
  - <https://news.ycombinator.com/item?id=48001979>
  - <https://news.ycombinator.com/item?id=48516666>
  - <https://news.ycombinator.com/item?id=48518013>
  - <https://news.ycombinator.com/item?id=49277249>
  - <https://news.ycombinator.com/item?id=49569760>
  - <https://news.ycombinator.com/item?id=50010671>
- Lobsters: <https://lobste.rs/c/hstlee>, <https://lobste.rs/c/ntrxht>,
  <https://lobste.rs/c/kvinug>, <https://lobste.rs/c/l5s8kr>
- Blogs:
  - <https://tritium.legal/blog/desktop>
  - <https://gpui-archipelago.github.io/news/315-day-vacuum/>
  - <https://gpui-archipelago.github.io/news/october-digest/>
  - <https://gpui-archipelago.github.io/news/pixels-in-surfaces-under/>
- This Week in Rust, issues from 2026-09-02 to 2026-10-21: GPUI tutorials only, with no
  comparison of the lines.
- Projects:
  - <https://github.com/yicheng47/runner/issues/733>
  - <https://github.com/cachix/agentaps/pull/5>
  - <https://github.com/cachix/factorseal/pull/70>
  - <https://github.com/pilgrimagesoftware/dtrpg/pull/16>
  - <https://github.com/0xErwin1/dbflux/issues/601>
  - <https://github.com/jasonwun/Astrolabe/pull/94>
  - <https://github.com/quazardous/tvty/pull/23>
  - <https://github.com/frostymur/aerofi/pull/48>
  - <https://github.com/macros-app/macros/pull/55>
  - <https://github.com/kunkka19xx/look/issues/544>
  - <https://github.com/MeowLynxSea/yororen-ui/issues/10>
  - <https://github.com/ayangweb/BongoCat/releases/tag/v2.0.0>
  - <https://github.com/cijiugechu/gpui-video-player>
  - <https://github.com/Airradda/gpui-video-player/pull/7>
  - <https://github.com/hummingbird-player/hummingbird>
