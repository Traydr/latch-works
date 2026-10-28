# Oriel RS: where the experiment stands

Oriel RS is Oriel ported to Rust on GPUI with GPUI Kit, as an experiment beside Electron Oriel
([plan 063](../../plans/063-oriel-rs.md)). Phase 0, the gate, and Phase 1, the foundations, were
both done on 2026-10-28, and the owner chose to go on. Since then Oriel RS builds its own LGPL
libmpv and a double-clickable `Oriel RS.app` ([runbook](../../runbooks/oriel-rs.md)). Phase 2,
the shell, is next.

## What matters

- **Oriel RS is ahead or level on every measure but video.** Electron Oriel opens and seeks
  video faster.
- **Most of Oriel is still to build.** Of 102 Electron Oriel features, 8 are done and 14 partly
  done. Tidy's engine has only its fingerprints and Convert's policies ported, and Sync, Settings
  and the links between modes are not started.
- **The ports match the TypeScript.** Natural order agrees but for 19 Han pairs, which the owner
  accepted, and fingerprints match bit for bit through sharp's own libvips.
- **Video plays through libmpv now.** It plays every container and seeks every codec exactly, at
  about 1.7 to 1.8 times AVPlayer's CPU. The app carries its own LGPL build (26 MB), made from
  pinned sources.
- **GPUI needed fixes the plan did not foresee.** Its image cache reached 11.5 GB in one scroll
  before Oriel RS bounded it.

## Against Electron Oriel

| Measure | Oriel RS | Electron Oriel | Oriel RS is |
|---|---:|---:|---|
| Size on disk | 176 MB `.app`, 128 MB of it ffmpeg and ffprobe | 502 MB | 2.9× smaller |
| Cold start to first thumbnails | 360 ms | 936 ms | 2.6× faster |
| Memory at rest (footprint) | 141 MB | 435 MB | 3× lighter |
| Memory after a full scroll (footprint) | 244 MB | 1,474 MB | 6× lighter |
| Gallery scroll, p95 / max frame | 9.7 / 10.5 ms | 9.7 / 16.3 ms | as smooth, with 0 long frames against 15 |
| Viewer step, AVIF / JPEG (p50) | 5.5 / 5.8 ms | 127 / 66 ms | 23× / 11× faster |
| Video open to first frame | 85–97 ms | 21–33 ms | 2.6–4× slower |
| Exact seek | 181–210 ms | 37–54 ms | about 4–5× slower, but on target in every codec |

The video rows are libmpv's, from Phase 1, and the rest is Phase 0's scorecard. Electron Oriel's
seek bar always seeks fast, so its UI never takes the exact path.

## Decided by the owner

- GPUI Kit on Zed's GPUI (line A), and a full port with no Node at runtime.
- Oriel RS keeps its own data in `~/.latch-works/oriel-rs/`, never Oriel's.
- Go past the gate.
- Video plays through libmpv by default, with AVPlayer only as the fallback. Build an LGPL libmpv.
- The 19 Han pairs are accepted, and sharp's libvips (about 18 MB) goes in the app.
- One branch, `agent/063-0-spike`, for the whole plan, and the name Oriel RS.

## Still open

- libavif: cmake as a build prerequisite, or a system or vendored libavif linked as the spike does.
- libvips: pin sharp's exact build, as the tests do, or accept any 8.18.x?
- Should View list HEIC files? Should natural order follow the system locale?

## The detail pages

- [Phase 0 measurements](phase-0-measurements.md): the STOP conditions, the full scorecard, the
  Library table, four video tiles, and what makes the comparison unfair.
- [Phase 0 ports](phase-0-ports.md): natural order, fingerprints, scan and SHA-256, and AVIF, each
  against the TypeScript.
- [Phase 0 findings](phase-0-findings.md): what GPUI did that the plan did not expect, and the fix
  for each.
- [Phase 1](phase-1.md): the foundations, and libmpv against AVPlayer.
- [Parity](parity.md): every Electron Oriel feature by area, its state in Oriel RS, and the phase
  that brings it.
