# Oriel RS: where the experiment stands

> **Outcome (2026-10-31):** Oriel RS replaced Electron Oriel and is now Oriel 1.0.0, in
> `apps/oriel` ([runbook](../../runbooks/oriel.md)). These pages keep the experiment's record under
> its old name; paths in them may point at what was `apps/oriel-rs` or at the removed Electron app.

Oriel RS is Oriel ported to Rust on GPUI with GPUI Kit, as an experiment beside Electron Oriel
([plan 063](../../plans/063-oriel-rs.md)). On macOS the port is done: the shell, View, Tidy, Sync,
the links between the modes and Settings, in a double-clickable `Oriel RS.app`
([runbook](../../runbooks/oriel-rs.md)). Phase 9's scorecard has been run, and the owner chose
to go on toward replacing Electron Oriel. After two optimization rounds, the parity round of
2026-10-31 ported what was left, added a DMG and an import of Electron Oriel's data, took Tidy out
of the sandbox, and made Windows build. Optimization resumes next.

## What matters

- **Everything Electron Oriel does on macOS is ported**, except a VoiceOver pass by a person: 99 of
  its 104 features are done, and the build workflow is left on purpose. Its 33 e2e cases are the
  plan's parity list: 32 pass as GPUI tests, and the migration case does not apply. Windows' 7
  rows compile but have not run (Partial).
- **It installs and brings Electron Oriel's data over.** `cargo run -p xtask -- dmg` makes a
  plain DMG. On first start the welcome offers to import Electron Oriel's data, which it reads and
  never writes. On a copy of the owner's data, every area came over in 1.4 s.
- **Oriel RS leads on everything but video, and two optimization rounds widened the lead.** It
  is 2.4 times smaller on disk and starts 3.6 times faster, and at rest it uses 2.9 times less
  memory. Tidy analyses the 21k fixture 2.9 times faster than glazier-core. Electron
  Oriel still opens video 1.4 to 2.2 times faster and seeks exactly 4 to 6 times faster.
- **The two implementations agree.** On the 21k fixture, Tidy's engine finds the same sets as
  glazier-core, with 0 differences, and every e2e Tidy change runs differentially against it. A
  Rust Sync plan equals the Lockstep CLI's. The ordering, format and fingerprint rules are pinned
  by vectors that the TypeScript writes.
- **Tidy works on any folder** (decision 18). A run with `ORIEL_RS_DATA_DIR` set, as checks and
  agents use, keeps the old sandbox. A safety review of the import, holding and the move to
  Applications found seven issues, all fixed before the first real use.
- **Optimizing goes on, workflow by workflow.** `cargo run -p xtask -- measure` repeats the
  scorecard's rows, so every change is measured A/B against the build before it.

## Against Electron Oriel

Oriel RS's numbers are from after the second optimization round (2026-10-31). Electron Oriel's
are Phase 9's, from the same Mac and fixture. Both come from the [scorecard](scorecard.md), as
medians of 3.

| Measure | Oriel RS | Electron Oriel | Oriel RS is |
|---|---:|---:|---|
| Size on disk | 205 MB `.app` | 502 MB | 2.4× smaller |
| Cold start to first thumbnails | 282 ms | 1,022 ms | 3.6× faster |
| All 20,000 stills listed | 48 ms | 1,430 ms | 30× faster |
| Memory at rest (footprint) | 149 MB | 436 MB | 2.9× lighter |
| Memory after a full scroll (footprint) | 238 MB | 1,469 MB | 6.2× lighter |
| Gallery scroll, p95 / long frames | 8.5 ms / 1 | 9.2 ms / 17 | as smooth, fewer long frames |
| Viewer step, AVIF / JPEG | 5.0 / 4.1 ms | 129 / 67 ms | 26× / 16× faster |
| Video open to first frame | 46–63 ms | 21–33 ms | 1.4–2.2× slower |
| Exact seek | 166–330 ms | 37–53 ms | 4–6× slower, but on target in every codec |
| Tidy: scan to Overview, 21k fixture | 117 s | 336.5 s (glazier-core, headless) | 2.9× faster |
| Sync push, 247 files | 0.79 s | 1.32 s (Lockstep CLI) | 1.7× faster |

## Decided by the owner

- GPUI Kit on Zed's GPUI (line A), and a full port with no Node at runtime.
- Oriel RS keeps its own data in `~/.latch-works/oriel-rs/`, never Oriel's.
- Go past the gate.
- Video plays through libmpv by default, with AVPlayer only as the fallback; the app carries an
  LGPL libmpv built from pinned sources.
- The 19 Han ordering pairs are accepted. Natural order never follows the system locale, as in
  Electron Oriel.
- Libraries come prebuilt where possible:
  - sharp's libvips (about 18 MB), with any 8.18.x accepted;
  - a vendored libavif.
- View lists HEIC stills as an Oriel RS addition.
- One branch, `agent/063-0-spike`, for the whole plan, and the name Oriel RS.
- On Phase 9 (decisions 11–15):
  - go on toward replacing Electron Oriel, optimizing every workflow first;
  - the sandbox stays, with no setting to lift it;
  - macOS 15 and later is fine;
  - the licence notices stand;
  - no real signing identity, notarization or auto-update for now.
- On the optimization rounds (decisions 16–24):
  - feature parity, installers on macOS and Windows, and the import of Electron Oriel's data come
    before more optimizing;
  - Oriel RS imports Electron Oriel's data, reading it without writing it;
  - Tidy leaves the sandbox;
  - no signing and no updater: a plain DMG and a simple Setup.exe;
  - GitHub CI runs only the typecheck;
  - Windows best effort, finished later on the owner's machine;
  - Sync hashes 16 at once, adapts uploads between 3 and 6, and prunes in parallel;
  - Tidy's thumbnails are capped at about 200 MB, Shrink keeps one encode, the 3.3 GB analysis
    peak stays, and a libvips with dav1d waits;
  - no FFmpeg build of our own for exact seeks; the warmed video player stays in memory.

## Still open

- **Retiring the Electron app**, once the owner has lived with Oriel RS on their own data.
- **Exact seeks** stay 4 to 6 times slower than Electron's, unless a runtime option in mpv helps;
  the owner wants no FFmpeg build of our own.
- **"Glazier" in two planner warnings** is kept so the differential runs still match
  glazier-core.
- **Windows (Phase 8)** builds and passes clippy for `x86_64-pc-windows-gnullvm`, but has not run.
  [The Windows runbook](../../runbooks/oriel-rs-windows.md) lists what the Windows agent must
  check, starting with Phase 8's video gate of 60 fps at 1080p.

## The detail pages

- [Scorecard](scorecard.md): Phase 9's numbers for both apps, what changed since Phase 0, the
  catch-up list, and what numbers miss.
- [Parity](parity.md): every Electron Oriel feature by area, its state in Oriel RS, the GPUI test
  for each e2e case, and where Oriel RS differs on purpose.
- [Phase 0 measurements](phase-0-measurements.md): the STOP conditions, the gate's scorecard, the
  Library table, four video tiles, and what makes the comparison unfair.
- [Phase 0 ports](phase-0-ports.md): natural order, fingerprints, scan and SHA-256, and AVIF, each
  against the TypeScript.
- [Phase 0 findings](phase-0-findings.md): what GPUI did that the plan did not expect, and the fix
  for each.
- [Phase 1](phase-1.md): the foundations, and libmpv against AVPlayer.
