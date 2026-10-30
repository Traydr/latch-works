# Oriel RS: where the experiment stands

Oriel RS is Oriel ported to Rust on GPUI with GPUI Kit, as an experiment beside Electron Oriel
([plan 063](../../plans/063-oriel-rs.md)). On macOS the port is done: the shell, View, Tidy, Sync,
the links between the modes and Settings, in a double-clickable `Oriel RS.app`
([runbook](../../runbooks/oriel-rs.md)). Phase 9's scorecard has been run. What is left is the
owner's decision, a few packaging steps and Windows.

## What matters

- **Nearly everything Electron Oriel does on macOS is ported.** 92 of its 104 features are done.
  Its 33 e2e cases are the plan's parity list: 32 pass as GPUI tests, and the migration case does
  not apply. What is left: a VoiceOver pass by a person, signing with a real identity, the DMG,
  the offer to move to Applications, a release workflow, and Windows.
- **The whole app kept Phase 0's lead on everything but video.**
  - It is 2.3 times smaller on disk and starts 2.7 times faster.
  - At rest it uses 2.1 times less memory.
  - It analyses the 21k fixture in glazier-core's time and pushes 1.7 times faster.
  - Electron Oriel still opens video 2.6 to 3.8 times faster.
- **The two implementations agree.** On the 21k fixture, Tidy's engine finds the same sets as
  glazier-core, with 0 differences, and every e2e Tidy change runs differentially against it. A
  Rust Sync plan equals the Lockstep CLI's. The ordering, format and fingerprint rules are pinned
  by vectors that the TypeScript writes.
- **Tidy changes files only in the sandbox.** Its changes run only on roots under
  `~/.latch-works/oriel-rs/sandbox` or the temp folder. Lifting that is the owner's call.
- **Two numbers want a look.**
  - View's memory grew with its index: 207 MB footprint at rest, against 141 MB at Phase 0.
  - Tidy sits at 1.5 GB resident after analysing the 21k fixture. Neither has been profiled yet.

## Against Electron Oriel

Medians of 3 on the same Mac and fixture, both apps measured on 2026-10-30
([scorecard](scorecard.md)).

| Measure | Oriel RS | Electron Oriel | Oriel RS is |
|---|---:|---:|---|
| Size on disk | 223 MB `.app` (97 MB without ffmpeg and ffprobe) | 502 MB | 2.3× smaller |
| Cold start to first thumbnails | 383 ms | 1,022 ms | 2.7× faster |
| All 20,000 stills listed | 151 ms | 1,430 ms | 9.5× faster |
| Memory at rest (footprint) | 207 MB | 436 MB | 2.1× lighter |
| Memory after a full scroll (footprint) | 367 MB | 1,469 MB | 4× lighter |
| Gallery scroll, p95 / long frames | 8.5 ms / 2 | 9.2 ms / 17 | as smooth, fewer long frames |
| Viewer step, AVIF / JPEG | 4.4 / 5.7 ms | 129 / 67 ms | 29× / 12× faster |
| Video open to first frame | 78–97 ms | 21–33 ms | 2.6–3.8× slower |
| Exact seek | 175–356 ms | 37–53 ms | 4–7× slower, but on target in every codec |
| Tidy: scan to Overview, 21k fixture | 332.5 s | 336.5 s (glazier-core, headless) | the same |
| Sync push, 247 files | 0.79 s | 1.32 s (Lockstep CLI) | 1.7× faster |
| Lines of code (and tests) | 65.6k (15.6k) | 53.3k (6.9k) | 1.2× the code |

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

## For the owner to decide

- **Phase 9:**
  - go on toward replacing Electron Oriel, which needs a plan for using Oriel's data and
    retiring the Electron app;
  - keep Oriel RS as an experiment;
  - or stop.
- **The sandbox:** whether to show the setting that lets Tidy change files outside the sandbox.
- **macOS 15 and later:** Homebrew's prebuilt aom, which libavif links, sets this floor. Oriel
  RS's own floor is 13. Lowering it means building aom ourselves or finding another prebuilt
  build.
- **The licence notices.**
  - The GPL notice for ffmpeg and ffprobe points at the upstream sources rather than making a
    written offer of our own.
  - 62 Rust crates ship no licence file of their own and are covered by shared MIT and
    Apache-2.0 texts.
- **"Glazier" in two planner warnings:** the text is kept so the differential runs still match
  glazier-core.
- **Signing, notarization and auto-update** need a Developer ID certificate and somewhere to
  publish updates.
- **Windows (Phase 8)** was not started.
- **On the next launch,** the first-run welcome shows once in the real data folder.

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
