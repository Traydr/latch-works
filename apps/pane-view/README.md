# Pane View

> Private web viewer for a synced personal media archive — responsive on desktop, tablet, and phone.

Pane View is the **web counterpart** to [Frame View](../frame-view). It serves an authenticated, read-only gallery backed by PostgreSQL metadata and S3 object storage. Content reaches Pane View through [Lockstep](../../tools/lockstep), which scans a local archive and pushes originals to the sync API.

## Features

- Authenticated private access (Better Auth)
- Folder-tree navigation with recursive browsing
- Virtualized thumbnail grid for large folders
- Comic mode — image folders grouped and opened in a comic reader
- Fullscreen media viewer for images, GIFs, video, and PDFs
- Video playback controls (play/pause, seek, speed)
- Sort modes: name, date, random
- Search, detail panel, favorites, and per-user viewer state (resume position)
- Signed CDN delivery for thumbnails; presigned redirects for originals
- Sync API for Lockstep push/plan/verify workflows

## Tech stack

| Layer | Choices |
| --- | --- |
| Framework | [TanStack Start](https://tanstack.com/start) + [TanStack Router](https://tanstack.com/router) |
| UI | React 19, Tailwind CSS 4, Radix UI |
| Auth | [Better Auth](https://www.better-auth.com/) |
| Database | PostgreSQL + [Drizzle ORM](https://orm.drizzle.team/) |
| Storage | S3-compatible object storage |
| Media | `sharp`, `ffmpeg-static`, `pdfjs-dist` |
| Shared libs | `@latch-works/media-domain`, `media-storage`, `media-delivery` |

## Prerequisites

- Node.js 22+
- pnpm 11
- PostgreSQL database
- S3-compatible bucket and credentials

## Environment

Pane View validates server environment variables at startup. Create `apps/pane-view/.env` with at least:

```env
DATABASE_URL=postgresql://...
BETTER_AUTH_SECRET=...
BETTER_AUTH_URL=http://127.0.0.1:3000
S3_ENDPOINT=https://...
S3_REGION=auto
S3_BUCKET=...
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
MEDIA_DELIVERY_SECRET=...          # min 32 chars
PANE_VIEW_USERNAME=...
PANE_VIEW_PASSWORD=...
PANE_VIEW_SYNC_TOKEN=...           # bearer token for Lockstep
```

`LOCKSTEP_API_TOKEN` on the CLI side should match `PANE_VIEW_SYNC_TOKEN`.

## Development

From the **repo root**:

```powershell
pnpm install
pnpm dev:pane
```

Or from this directory:

```powershell
pnpm dev
```

The dev server binds to `127.0.0.1` and loads `.env` when present.

### Database migrations

```powershell
pnpm db:generate   # generate migration from schema changes
pnpm db:migrate    # apply migrations
```

### Scripts

| Script | Description |
| --- | --- |
| `pnpm dev` | Vite dev server |
| `pnpm build` | Production build |
| `pnpm start` | Run built server (`.output/server`) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Vitest |

## Syncing content

Use [Lockstep](../../tools/lockstep) to publish a local folder tree:

```powershell
# From repo root
$env:LOCKSTEP_API_URL = "http://127.0.0.1:3000"
$env:LOCKSTEP_API_TOKEN = "your-sync-token"
pnpm start:lockstep -- push --source "T:\cloud-desktop\media"
```

Start with `plan` (read-only) or `doctor` to verify connectivity before pushing.

## Project structure

```text
src/
├── routes/              # TanStack Router pages and API routes
├── features/
│   ├── gallery/         # Grid, sidebar, viewer modal
│   ├── comics/          # Comic reader
│   ├── library/         # Library snapshot service
│   ├── media/           # Thumbnail/delivery helpers
│   └── settings/        # Theme, hotkeys, preferences
├── server/
│   ├── auth/            # Better Auth + session
│   ├── db/              # Drizzle schema
│   └── library/         # PostgreSQL library queries
└── components/ui/       # Shared UI primitives
```

## Related docs

- [Lockstep runbook](../../docs/runbooks/lockstep.md)
- [Railway CDN setup](../../docs/runbooks/railway-cdn-pane-view.md)
- [Thumbnail runbook](../../docs/runbooks/pane-view-thumbnails.md)
- [Architecture plan](../../docs/ARCHITECTURE_PLAN.md)
