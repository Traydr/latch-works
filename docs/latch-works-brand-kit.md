# Latch Works Brand Kit

## 1. Brand Overview

**Latch Works** is the umbrella project for a private media archive and viewer ecosystem.

It brings together a desktop viewer, web viewer, browser extension, sync CLI, and shared packages into one cohesive monorepo. The system is built around a simple flow:

```text
Gather → Organize → Sync → View
```

The naming theme is based on window-adjacent parts and access metaphors:

- A **frame** holds the view.
- A **pane** is a viewing surface.
- A **latch** controls access.
- A **box** collects and stores.
- **Lockstep** implies reliable synchronized movement.

The overall feel should be private, practical, calm, and tool-like rather than flashy or public-facing.

---

## 2. Name System

| Area | Name | Role |
|---|---|---|
| Monorepo / ecosystem | **Latch Works** | The full private tool system and shared workspace |
| Desktop app | **Frame View** | Local desktop media viewer |
| Web app | **Pane View** | Private web/mobile media viewer |
| Browser extension | **Gather Box** | Content collection/downloader extension |
| Sync CLI | **Lockstep** | Local archive to remote web archive sync tool |

---

## 3. Brand Concept

### Core idea

**Latch Works is a private workshop for viewing, collecting, and syncing personal archived media.**

It is not a social platform, public gallery, or cloud replacement. It is a controlled personal system where media enters through Gather Box, is organized locally, synced through Lockstep, and viewed through Frame View or Pane View.

### Brand keywords

- Private
- Structured
- Calm
- Useful
- Local-first
- Archive-aware
- Viewer-focused
- Practical
- Secure
- Personal

### Avoid

- Overly corporate language
- Public-sharing language
- Crypto/Web3/security-theater vibes
- Cute mascot-style branding
- “Cloud drive replacement” positioning
- Overstating automation or intelligence

---

## 4. Naming Rationale

### Latch Works

**Latch Works** is the name of the monorepo and broader ecosystem.

A latch is a small mechanism that controls access. “Works” suggests a workshop, system, or set of working tools. Together, the name fits a private software ecosystem that manages access to a personal media archive.

Use this name when referring to the full project, repository, architecture, or product family.

Examples:

```text
Latch Works is the monorepo for the private media viewer ecosystem.
Latch Works contains Frame View, Pane View, Gather Box, Lockstep, and shared packages.
```

### Frame View

**Frame View** is the desktop app.

The name fits a local viewer because a frame surrounds and presents media. It also connects naturally to image frames, video frames, and UI frames.

Use this name when referring to the Electron desktop app.

Examples:

```text
Frame View is the local desktop gallery viewer.
Frame View remains the reference experience for media navigation and viewing.
```

### Pane View

**Pane View** is the web app.

A pane is one section of a window and a natural web/browser metaphor. It suggests a viewing surface without implying public access. It also pairs cleanly with Frame View.

Use this name when referring to the private TanStack Start web viewer.

Examples:

```text
Pane View brings the Frame View-style experience to web, iPad, and iPhone.
Pane View is read-only by default and requires authentication.
```

### Gather Box

**Gather Box** is the browser extension.

The name describes a tool that collects content into a local archive. “Gather” communicates collection without sounding too aggressive, and “Box” implies a container.

Use this name when referring to the extension that downloads and organizes source content.

Examples:

```text
Gather Box saves source media into local archive folders.
Gather Box can later write sidecar metadata for richer indexing.
```

### Lockstep

**Lockstep** is the sync CLI.

The name implies synchronized movement, reliability, and controlled access. It fits a command-line tool that moves the local archive state into the remote private viewer.

Use this name when referring to the sync, ingest, verify, and publish CLI.

Examples:

```text
Lockstep plans and pushes local archive changes to Pane View.
Lockstep should never delete remote media unless explicitly instructed.
```

---

## 5. Product Architecture Language

Use simple pipeline wording:

```text
Gather Box collects.
Frame View verifies locally.
Lockstep syncs.
Pane View displays privately.
Latch Works holds everything together.
```

Expanded version:

```text
Gather Box brings media into the local archive.
Frame View provides the local reference viewing experience.
Lockstep publishes selected archive state to the hosted backend.
Pane View provides authenticated web and mobile viewing.
Latch Works keeps the apps, tools, and shared packages in one system.
```

---

## 6. Tone and Voice

### Tone

The tone should be:

- Direct
- Quiet
- Technical
- Personal
- Confident
- Minimal

### Example tone

Good:

```text
Private media viewing across desktop and web.
Sync local archive paths into Pane View.
Read-only by default. Explicit sync only.
```

Avoid:

```text
The ultimate revolutionary cloud-powered media experience.
Your magical AI gallery companion.
Share and discover your media with the world.
```

### Writing rules

Prefer:

- “private” over “secure” unless discussing actual security controls
- “sync” over “upload magic”
- “archive” over “library” when referring to the whole media collection
- “viewer” over “platform”
- “local archive” over “cloud drive”
- “explicit sync” over “automatic mirroring”

---

## 7. Visual Direction

This is an internal/private tool ecosystem, so the visual identity should be restrained.

### Suggested visual mood

- Dark-first, but not black-only
- Subtle borders
- Glass/pane/window metaphors used sparingly
- Clear icons over decorative branding
- Low saturation
- Soft contrast
- Practical spacing
- No glossy SaaS marketing style

### Visual keywords

- Window
- Frame
- Pane
- Latch
- Archive
- Grid
- Track
- Path
- Shelf
- Shadow
- Lock

### Avoid

- Bright neon cyberpunk unless used only as an accent
- Overdone glassmorphism
- Corporate blue gradients
- Heavy mascot/icon branding
- Padlocks everywhere
- Public social-gallery visual language

---

## 8. Logo / Icon Concepts

These are not final logos, just directions.

### Latch Works

Possible icon concepts:

- A simple window frame with a small latch mark
- Four-pane grid with one small locked/latching corner
- A square frame with an offset mechanical notch
- A monorepo/workshop mark: frame + small tool/latch element

Shape language:

- Square or rounded-square base
- Thin internal dividers
- One distinctive latch/notch detail
- Works well as a repo/avatar icon

### Frame View

Possible icon concepts:

- Framed image rectangle
- Media frame with play/image hybrid
- Four-corner crop/frame mark
- Gallery tile inside a frame

### Pane View

Possible icon concepts:

- Single pane inside a browser-like window
- Split window with one highlighted pane
- Minimal rectangular glass pane
- Browser viewport with media tile

### Gather Box

Possible icon concepts:

- Box/tray receiving small tiles
- Browser tab arrowing into a box
- Collection tray with stacked images
- Open box with a small pane/frame inside

### Lockstep

Possible icon concepts:

- Two aligned steps/tracks
- Sync arrows with a latch/key detail
- Path line with locked endpoint
- Footstep/track metaphor, kept abstract

---

## 9. Suggested Repo and Package Naming

### Repository

Recommended repository name:

```text
latch-works
```

Alternative:

```text
latchworks
```

Prefer `latch-works` for readability.

### App folders

```text
apps/
  frame-view/
  pane-view/
  gather-box/
```

### Tool folders

```text
tools/
  lockstep/
```

### Shared packages

Suggested shared package names:

```text
packages/
  media-domain/
  media-ui/
  media-storage/
  media-index/
  auth/
  config/
```

Optional branded package scope if publishing internally:

```text
@latchworks/media-domain
@latchworks/media-ui
@latchworks/media-storage
@latchworks/media-index
@latchworks/auth
@latchworks/config
```

If using only private workspace packages, this is also fine:

```text
@latch-works/media-domain
@latch-works/media-ui
@latch-works/media-storage
@latch-works/media-index
```

Use one style consistently.

---

## 10. Command Naming

### Lockstep CLI binary

Recommended binary name:

```text
lockstep
```

Example commands:

```powershell
lockstep plan --source "D:\Archive" --remote production
lockstep push --source "D:\Archive" --remote production
lockstep verify --source "D:\Archive" --remote production
lockstep prune --source "D:\Archive" --remote production --dry-run
```

Avoid naming the binary `sync`, `upload`, or `latch` because those are more generic and less searchable.

### Command language

Use these verbs:

| Verb | Meaning |
|---|---|
| `plan` | Calculate changes without applying them |
| `push` | Upload and register changes |
| `verify` | Compare local and remote state |
| `prune` | Explicitly mark/remove stale remote entries |
| `status` | Show current configuration and last run |
| `auth` | Manage API token/login config |
| `doctor` | Diagnose local setup |

Suggested future command shape:

```powershell
lockstep status
lockstep auth login
lockstep plan
lockstep push
lockstep verify
lockstep doctor
```

---

## 11. Short Descriptions

### Latch Works

One-liner:

```text
A private media viewer ecosystem for collecting, syncing, and browsing a local archive across desktop and web.
```

Short description:

```text
Latch Works is the monorepo for a private media archive system. It contains the Frame View desktop app, Pane View web app, Gather Box browser extension, Lockstep sync CLI, and shared media packages.
```

### Frame View

One-liner:

```text
A private desktop media viewer for local image, video, comic, and story archives.
```

Short description:

```text
Frame View is the local desktop viewer and reference experience for browsing archived images, GIFs, videos, and comics. PDF reading is planned, not shipped.
```

### Pane View

One-liner:

```text
A private web viewer for browsing synced media archives on desktop, iPad, and iPhone.
```

Short description:

```text
Pane View brings the Frame View-style archive browsing experience to the web with authenticated, read-only access to synced media.
```

### Gather Box

One-liner:

```text
A browser extension for gathering source media into a local archive.
```

Short description:

```text
Gather Box collects media from supported pages and saves it into structured local folders for later viewing and syncing.
```

### Lockstep

One-liner:

```text
A sync CLI for publishing local archive changes to the private web viewer.
```

Short description:

```text
Lockstep scans local archive paths, plans changes, uploads media, and verifies remote state for Pane View.
```

---

## 12. Internal Taglines

These are optional. Use sparingly.

### Latch Works

```text
Private media tools, working in sync.
```

```text
Gather, sync, and view your archive.
```

```text
A private workspace for personal media viewing.
```

### Frame View

```text
Your local archive, framed.
```

```text
Fast local viewing for personal media archives.
```

### Pane View

```text
Your archive through a private pane.
```

```text
Frame View, through the browser.
```

### Gather Box

```text
Collect first. Organize later.
```

```text
Gather source media into your archive.
```

### Lockstep

```text
Move your archive in step.
```

```text
Plan, push, verify.
```

---

## 13. README Header Example

```md
# Latch Works

Private media tools for collecting, syncing, and viewing a personal archive across desktop and web.

## Apps

- **Frame View** — desktop media viewer
- **Pane View** — authenticated web media viewer
- **Gather Box** — browser extension for collecting source media

## Tools

- **Lockstep** — sync CLI for publishing local archive changes

## Packages

- **media-domain** — shared media types, schemas, sorting, and grouping
- **media-ui** — reusable gallery/viewer components
- **media-storage** — object storage and signed media URL helpers
- **media-index** — scan, hash, manifest, and metadata extraction logic
```

---

## 14. Usage Rules

### Capitalization

Use title case for product names:

```text
Latch Works
Frame View
Pane View
Gather Box
Lockstep
```

Use kebab-case for folder and package names:

```text
latch-works
frame-view
pane-view
gather-box
lockstep
```

Use lowercase for CLI invocation:

```text
lockstep push
```

### Do

```text
Pane View is part of Latch Works.
Lockstep syncs local archive changes.
Gather Box saves source media into structured folders.
Frame View is the desktop reference viewer.
```

### Do not

```text
PaneView
FrameView
GatherBox
LatchWorks
LockStep
```

Unless needed for code identifiers.

### Code identifier style

Use PascalCase for app display constants:

```ts
const APP_NAME = "Pane View"
```

Use camelCase for internal identifiers:

```ts
const paneViewConfig = {}
const gatherBoxManifest = {}
const lockstepRun = {}
```

---

## 15. Suggested Monorepo README Opening

```md
# Latch Works

Latch Works is a private media viewer ecosystem for collecting, syncing, and browsing a personal archive across desktop and web.

The system is built around a local-first archive workflow:

1. **Gather Box** collects source media into structured local folders.
2. **Frame View** provides the local desktop viewing experience.
3. **Lockstep** syncs selected archive state to the hosted backend.
4. **Pane View** provides authenticated web and mobile viewing.

The project is intentionally read-focused. The web viewer is not a public gallery and does not replace the local archive as the source of truth.
```

---

## 16. Final Recommended Identity

```text
Latch Works
├─ Frame View
├─ Pane View
├─ Gather Box
└─ Lockstep
```

Best folder layout:

```text
latch-works/
  apps/
    frame-view/
    pane-view/
    gather-box/
  tools/
    lockstep/
  packages/
    media-domain/
    media-ui/
    media-storage/
    media-index/
    auth/
    config/
  docs/
    architecture/
    decisions/
    runbooks/
```

Best mental model:

```text
Gather Box brings content in.
Frame View makes it easy to inspect locally.
Lockstep moves it in sync.
Pane View makes it available privately.
Latch Works holds the system together.
```
