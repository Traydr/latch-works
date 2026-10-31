# Oriel RS: where the experiment stands

Oriel RS is Oriel ported to Rust on GPUI with GPUI Kit, as an experiment beside Electron Oriel
([plan 063](../../plans/063-oriel-rs.md)). On macOS the port is done: the shell, View, Tidy, Sync,
the links between the modes and Settings, in a double-clickable `Oriel RS.app`
([runbook](../../runbooks/oriel-rs.md)). Phase 9's scorecard has been run, and the owner chose
to go on toward replacing Electron Oriel. Optimizing every workflow comes first; a few packaging
steps and Windows are left.

## What matters

- **Nearly everything Electron Oriel does on macOS is ported.** 92 of its 104 features are done.
  Its 33 e2e cases are the plan's parity list: 32 pass as GPUI tests, and the migration case does
  not apply. What is left: a VoiceOver pass by a person, signing with a real identity, the DMG,
  the offer to move to Applications, a release workflow, and Windows.
- **Oriel RS leads on everything but video, and two optimization rounds widened the lead.** It
  is 2.4 times smaller on disk and starts 3.6 times faster, and at rest it uses 2.9 times less
  memory. Tidy analyses the 21k fixture 2.9 times faster than glazier-core. Electron
  Oriel still opens video 1.4 to 2.2 times faster and seeks exactly 4 to 6 times faster.
- **The two implementations agree.** On the 21k fixture, Tidy's engine finds the same sets as
  glazier-core, with 0 differences, and every e2e Tidy change runs differentially against it. A
  Rust Sync plan equals the Lockstep CLI's. The ordering, format and fingerprint rules are pinned
  by vectors that the TypeScript writes.
- **Tidy changes files only in the sandbox.** Its changes run only on roots under
  `~/.latch-works/oriel-rs/sandbox` or the temp folder. Lifting that is the owner's call.
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

## Still open

- **Optimization trade-offs** the first round left to the owner: wider hashing and upload queues
  in Sync, a cap on Tidy's thumbnail memory, Shrink's encodes at once, Tidy's peak memory during
  the analysis, a libvips with dav1d, and patched FFmpeg decoders for exact seeks.
- **Using Oriel's data and retiring the Electron app** need a plan of their own.
- **"Glazier" in two planner warnings** is kept so the differential runs still match
  glazier-core.
- **Windows (Phase 8)** is not started.

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
