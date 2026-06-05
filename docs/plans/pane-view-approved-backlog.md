# Pane View Approved Backlog

Last updated: 2026-06-05  
Status: **Approved from product feedback** — ready for Phase 7 implementation.

## Sources

| Doc | Role |
| --- | --- |
| [pane-view-issue-feedback.md](../analysis/pane-view-issue-feedback.md) | Your decisions (authoritative) |
| [pane-view-issue-analysis.md](../analysis/pane-view-issue-analysis.md) | Technical analysis |
| [pane-view-issue-clarifications.md](../analysis/pane-view-issue-clarifications.md) | Expanded specs for unclear items |

## Product direction (from feedback)

1. **Performance first** — folder loading, recursive behaviour, and query shape are P0; large collections must not load entire subtrees by default.
2. **Recursive off by default** — user opts in per session; archive root must not allow recursive mode (**S-05**, **N-04**).
3. **Personal single-user site** — skip per-account thumbnail throttling, pre-warm at scale, and resume/cross-device state for now.
4. **Mobile viewer matters** — tap-to-open, full-height nav zones, PDF reader; mobile search and detail panel are lower priority than perf.
5. **Gallery view only** — no list/density modes (**T-09** skip).

---

## Priority legend

| Priority | Meaning |
| --- | --- |
| **P0** | Do now — blocks daily use or perf |
| **P1** | Next — high value after P0 |
| **P2** | Later polish |
| **Backlog** | Interested but not scheduled |
| **Skip** | Explicitly not doing |

---

## P0 — Phase 7a (performance & core UX)

Ship as one coordinated slice where items depend on each other.

### Work package A: Loader & recursive defaults

| ID | Task | Notes |
| --- | --- | --- |
| **S-05** | Default `recursive: false` in `useGalleryState` | Breaking change for existing localStorage users |
| **P-01** | Loader queries direct children when `recursive: false` | Add `recursive` to `loaderDeps` + `getLibrarySnapshot` input |
| **N-04** | Disable recursive toggle at archive root | Auto-off when `currentPath === ""` |
| **P-04** | Fetch `allFolders` only when needed | Comic mode on or sidebar tree; else ancestors + children |
| **P-05** | DB index audit | `parentPath`, `logicalPath`, `deletedAt`, thumbnail join |
| **P-02** | Reduce client heavy work | Server-side sort/filter where cheap; **route pending UI** during loader |

**Exit criteria:** Navigating a folder with 10k descendants in non-recursive mode returns only direct children; archive root loads in bounded time; navigation shows loading state.

### Work package B: Settings shell (minimal)

| ID | Task | Notes |
| --- | --- | --- |
| **S-01** | Settings drawer or `/settings` | Usability tab first: recursive default, placeholder for P1 toggles |
| **T-04** | Thumbnail pending UX | Pulsing grey/skeleton in `Poster`; retry on 503 (from P-06 feedback) |

### Work package C: Mobile activation & viewer

| ID | Task | Notes |
| --- | --- | --- |
| **M-01** | Single-tap opens media and folders on mobile | Keep double-click on desktop |
| **M-04** | Mobile viewer layout | Safe areas, auto-hide chrome, collapse metadata |
| **M-05** | Prev/next via invisible zones | Left/right 50% height-full hit targets; remove visible side arrows on mobile (see clarifications) |
| **M-10** | Minimal PDF viewer | Spike PDF.js (or alt); replace iframe-only mobile experience |

**Exit criteria:** Phone user can open folder and media in one tap; viewer navigates via tap zones; PDFs readable on mobile.

---

## P1 — Phase 7b (settings, gallery, navigation)

| ID | Task | Decision |
| --- | --- | --- |
| **S-08** | Autoplay videos in viewer | Agree |
| **S-09** | Loop videos in viewer | Agree |
| **S-11** | Show images / show videos filters | Agree |
| **S-13** | Per-root prefs | Agree — **per-device** localStorage only |
| **S-14** | Hotkey reference in settings | Agree |
| **S-02** | Theme system/light/dark | Agree — `next-themes` (see clarifications) |
| **S-10** | Loop viewer navigation | Agree after clarification — default TBD |
| **P-03** | Paginated search | Agree |
| **P-07** | Dynamic thumb size from card × DPR | Agree (see clarifications) |
| **P-08** | Viewport thumb priority | Agree |
| **P-10** | Preview-first images in viewer | Agree — original on explicit action |
| **P-11** | Adjacent prefetch | Nice to have |
| **M-08** | Sidebar touch targets + hover highlight | Agree |
| **M-09** | Toolbar IA — account in sidebar, browse in center | Agree |
| **N-01** | Parent/sibling buttons top of gallery | Agree |
| **N-05** | Refresh loading indicator | Agree |
| **D-01** | Rich detail panel (size, dimensions, duration, mtime) | Agree |
| **V-07** | Copy path / download | Agree |
| **V-09** | Viewer focus trap + aria labels | Agree |
| **C-01** | Vertical scroll comic reader | Agree — port Frame View `ComicReader` |
| **C-02** | Scroll-synced page indicator | Part of C-01 |
| **C-03** | Lazy per-page loading | Part of C-01 |
| **C-04** | Scroll-to-top / go to cover folder | Agree |
| **K-03** | Shortcut guards when settings open | Agree |
| **K-04** | In-app hotkey overlay (`?`) | Agree |
| **R-07** | Keyboard shortcut overlay | Same as K-04 |
| **O-04** | Abort-aware thumb queue on fast scroll | Agree |
| **T-07** | Gallery keyboard wrap | Agree — inferred P1 polish |

---

## P2 — Phase 7c (polish)

| ID | Task | Decision |
| --- | --- | --- |
| **M-02** | Mobile search dialog | Agree — icon opens sheet |
| **M-07** | Mobile breadcrumb / folder title UX | Modify — see clarifications |
| **S-03** | Thumbnail size slider | Agree |
| **T-08** | Animated GIF → WebP strategy | Agree — spike animated WebP |
| **T-01** | Video hover autoplay grid | Backlog |
| **T-02** | VIDEO badge | Agree — low priority |
| **O-01** | Diagnostics JSON snapshot | Agree |
| **O-05** | Confirm dialogs for destructive ops | Agree |

---

## Backlog

| ID | Task | Notes |
| --- | --- | --- |
| **M-03** | Mobile detail sheet | Deferred |
| **M-06** | Hover-only labels / labeled grid | Deferred |
| **M-11** | PWA installable shell | Future interest |
| **P-09** | Video preload tuning | TBD |
| **P-12** | Performance instrumentation | When optimizing |
| **S-04** | Remember last folder toggle | |
| **S-06, S-07** | Hover video/audio preview | |
| **S-15** | Debug toggles | |
| **N-06** | Auto-refresh after sync | Defer |
| **N-07** | Recent / pinned folders | Defer |
| **S-12** | Custom extensions UI | See clarifications — only if needed |

---

## Skip / won't fix

| ID | Task | Reason |
| --- | --- | --- |
| **P-06** | Thumbnail pre-warm / per-account limits | Fast enough for single-user; T-04 covers UX |
| **P-12** | (duplicate defer) | Instrumentation deferred |
| **T-03** | 2× retina thumbs | Covered by P-07 |
| **T-05** | Header status bar | Skip |
| **T-06** | Incremental gallery stream | Prefer paging (P-01/P-02) |
| **T-09** | Density / list modes | Gallery only |
| **N-02** | Navigation ceiling | Skip after clarification |
| **N-03** | Folder grid overlay | Skip |
| **V-01** | Viewer resume | Not needed for short videos |
| **V-02** | Read/viewed indicators | Skip |
| **V-03** | Codec in metadata | Skip |
| **V-04** | Video ended → advance | Skip |
| **V-05** | rAF coalesced Q/E | Skip unless stutter observed |
| **V-06** | Reveal in folder | N/A |
| **D-02** | Client ffprobe | N/A |
| **D-03** | Media tools status UI | Skip |
| **D-04** | Metadata side panel in viewer | Skip |
| **K-05** | Activation discoverability | Skip (M-01 covers mobile) |
| **K-06** | Reduced motion | Skip |
| **X-01** | Server resume | Skip |
| **X-02** | Cross-device prefs | Skip |
| **X-03** | localStorage failure toast | Skip |
| **R-01–R-06, R-08** | v1.1 roadmap items | Skip except R-07 (= K-04) |
| **S-16, S-17, N-08** | Platform non-goals | Confirmed |

---

## Implementation sequence

Recommended order within Phase 7:

```
7a.1  S-05 + P-01 + N-04          ← recursive off + correct queries
7a.2  P-04 + P-05                 ← smaller folder fetch + indexes
7a.3  P-02                        ← loading UI + server wins where easy
7a.4  T-04                        ← thumb pending pulse
7a.5  S-01 (minimal)              ← settings shell + recursive default exposed
7a.6  M-01                        ← mobile tap
7a.7  M-04 + M-05                 ← viewer tap zones
7a.8  M-10                        ← PDF spike + ship

7b.*  P1 table in any logical grouping (settings toggles, comic reader, P-03, P-10, …)

7c.*  P2 polish
```

**Critical path:** 7a.1 → 7a.2 → 7a.3. Do not ship S-05 without P-01.

---

## Phase 7a task checklist (copy for PRs)

- [ ] `recursive` in route loader deps and library service
- [ ] Repository: `parentPath = currentPath` when non-recursive
- [ ] `useGalleryState`: default `recursive: false`
- [ ] UI: disable recursive at archive root (N-04)
- [ ] Conditional `allFolders` fetch (P-04)
- [ ] Index migration if audit finds gaps (P-05)
- [ ] `router` pending / skeleton during navigation (P-02)
- [ ] `Poster` loading pulse + 503 retry (T-04)
- [ ] Settings entry point (S-01)
- [ ] Mobile single-tap activate (M-01)
- [ ] Viewer invisible prev/next zones (M-04, M-05)
- [ ] PDF viewer evaluation + implementation (M-10)

---

## Open decisions (need your call)

| ID | Question | Suggested default |
| --- | --- | --- |
| **S-10** | Loop viewer navigation default on or off? | **On** (Frame View parity) |
| **S-12** | Custom extensions UI ever? | **Backlog** until unsupported file appears |
| **M-10** | PDF.js vs native iframe + CSS | **PDF.js** for control and mobile |
| **P-10** | Original load trigger: button vs pinch | **Button** first, pinch later |

---

## Success metrics (informal)

For personal archive use — no formal analytics required per feedback:

- Non-recursive folder navigation feels instant for folders with large subtrees.
- Archive root does not offer recursive mode.
- Mobile: one tap opens media; viewer prev/next works without visible arrows.
- Grid shows pulse placeholder while thumbs generate.
- PDFs open in a controlled reader on phone.

---

## Changelog

| Date | Change |
| --- | --- |
| 2026-06-05 | Initial backlog from feedback + clarifications doc |
