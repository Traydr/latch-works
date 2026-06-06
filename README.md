# Latch Works

> A private workshop for collecting, organizing, syncing, and viewing a personal media archive — across desktop, web, and the browser.

[![TypeScript](https://img.shields.io/badge/TypeScript-6-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![pnpm](https://img.shields.io/badge/pnpm-workspace-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![Private](https://img.shields.io/badge/status-private-lightgrey)](#)

Latch Works is a **pnpm monorepo** that brings together viewers, a collection tool, a sync CLI, and shared media libraries into one ecosystem. The local archive stays the source of truth; remote access is explicit, authenticated, and read-only.

```text
Gather  →  Organize  →  Sync  →  View
  │            │           │         │
Gather Box   Frame View  Lockstep  Pane View
             (desktop)              (web/mobile)
```

---

## What's in the repo

| Name | Path | What it does |
| --- | --- | --- |
| **Pane View** | [`apps/pane-view`](apps/pane-view) | Private web viewer for browsing a synced archive on desktop, tablet, and phone. TanStack Start + PostgreSQL + S3. |
| **Frame View** | [`apps/frame-view`](apps/frame-view) | Cross-platform **Electron** desktop gallery for local image, video, comic, and PDF folders. The UX north star for Pane View. |
| **Gather Box** | [`apps/gather-box`](apps/gather-box) | **Chrome extension** that downloads image galleries and story PDFs from supported sites into inferred local folder structures. |
| **Lockstep** | [`tools/lockstep`](tools/lockstep) | CLI that scans a local archive, plans changes, and **pushes** originals to the Pane View sync API. |

### Shared packages

| Package | Path | Role |
| --- | --- | --- |
| `@latch-works/media-domain` | [`packages/media-domain`](packages/media-domain) | Media types, path helpers, gallery sort/comic grouping, Zod schemas |
| `@latch-works/media-index` | [`packages/media-index`](packages/media-index) | Archive scanning and sync-plan generation |
| `@latch-works/media-storage` | [`packages/media-storage`](packages/media-storage) | Content-addressed S3 object key conventions and helpers |
| `@latch-works/media-delivery` | [`packages/media-delivery`](packages/media-delivery) | Signed CDN delivery tokens for thumbnails and previews |

---

## Workspace layout

```text
latch-works/
├── apps/
│   ├── pane-view/       # TanStack Start web viewer
│   ├── frame-view/      # Electron desktop viewer
│   └── gather-box/      # Chrome extension
├── packages/
│   ├── media-domain/
│   ├── media-index/
│   ├── media-storage/
│   └── media-delivery/
├── tools/
│   └── lockstep/        # Local → remote sync CLI
└── docs/
    ├── ARCHITECTURE_PLAN.md
    ├── decisions/
    └── runbooks/
```

---

## Prerequisites

- **Node.js** 22+ (LTS recommended)
- **pnpm** 11 (`corepack enable` or install globally)
- **PostgreSQL** — required for Pane View
- **S3-compatible storage** — required for Pane View media originals
- **ffmpeg** — optional locally; Pane View bundles `ffmpeg-static` for thumbnails/posters

Frame View additionally needs npm on `PATH` for Electron Forge packaging.

---

## Getting started

Install all workspace dependencies from the repo root:

```powershell
pnpm install
```

Run the full workspace check (build, test, typecheck):

```powershell
pnpm check
```

### Quick commands

| Command | Description |
| --- | --- |
| `pnpm dev:pane` | Start Pane View dev server |
| `pnpm start:lockstep` | Run Lockstep (interactive wizard when TTY) |
| `pnpm --filter @latch-works/frame-view start` | Start Frame View (Electron dev) |
| `pnpm --filter @latch-works/gather-box build` | Build Gather Box extension to `dist/` |
| `pnpm lint` | Biome check across the repo |
| `pnpm test` | Run tests in all packages |

### Lockstep example

`plan` is read-only — it scans the source tree and prints a sync plan without changing anything:

```powershell
pnpm start:lockstep -- plan --source "T:\cloud-desktop\media"
```

Push changed files to a running Pane View instance:

```powershell
$env:LOCKSTEP_API_URL = "http://localhost:3000"
$env:LOCKSTEP_API_TOKEN = "your-sync-token"
pnpm start:lockstep -- push --source "T:\cloud-desktop\media"
```

See [`tools/lockstep/README.md`](tools/lockstep/README.md) and [`docs/runbooks/lockstep.md`](docs/runbooks/lockstep.md) for the full command reference.

---

## Design principles

- **Private by default** — authentication gates web access; no public galleries.
- **Read-only remote** — Pane View browses synced content; Lockstep is the write path.
- **Local source of truth** — the desktop archive drives what gets synced.
- **Shared domain logic** — gallery sorting, comic grouping, and scan planning live in packages, not duplicated per app.

---

## Documentation

| Doc | Description |
| --- | --- |
| [`docs/ARCHITECTURE_PLAN.md`](docs/ARCHITECTURE_PLAN.md) | System design, scope, and consolidation plan |
| [`docs/latch-works-brand-kit.md`](docs/latch-works-brand-kit.md) | Naming, tone, and product vocabulary |
| [`docs/runbooks/lockstep.md`](docs/runbooks/lockstep.md) | Lockstep operations runbook |
| [`docs/runbooks/railway-cdn-pane-view.md`](docs/runbooks/railway-cdn-pane-view.md) | Pane View CDN and delivery setup |
| [`docs/runbooks/pane-view-thumbnails.md`](docs/runbooks/pane-view-thumbnails.md) | Thumbnail generation notes |

---

## Naming

The product names follow a window-and-access metaphor:

| Term | Meaning |
| --- | --- |
| **Latch** | Controls access to the archive |
| **Frame** | The desktop viewing surface |
| **Pane** | The web viewing surface |
| **Box** | Collects and stores incoming media |
| **Lockstep** | Keeps local and remote archives in sync |

---

## License

- **Frame View** is [MIT](apps/frame-view/LICENSE).
- The rest of the monorepo is private and not licensed for redistribution.
