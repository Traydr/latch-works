# Pane View

> Private web viewer for a synced personal media archive — responsive on desktop, tablet, and phone.

Pane View is the web viewer of the archive. It serves an authenticated gallery backed by PostgreSQL metadata and S3 object storage. The browser UI is read-oriented: catalog writes happen through Lockstep sync APIs, while signed-in users can soft-delete entries from the gallery UI. Content reaches Pane View through [Lockstep](../../apps/lockstep-cli), which scans a local archive and pushes originals to the sync API.

## Features

- Authenticated private access (Better Auth)
- Folder-tree navigation with recursive browsing
- Virtualized thumbnail grid for large folders
- Comic mode — image folders grouped and opened in a comic reader
- Fullscreen media viewer for images, GIFs, video, and PDFs
- Video playback controls (play/pause, seek, speed)
- Sort modes: name, date, random
- Search and detail panel
- Resume where you left off in videos and PDFs (optional, per user)
- Shutter-served thumbnails, previews, and originals; signed bucket URLs without Shutter
- Sync API for Lockstep push/plan/verify workflows

## Tech stack

| Layer | Choices |
| --- | --- |
| Framework | [TanStack Start](https://tanstack.com/start) + [TanStack Router](https://tanstack.com/router) |
| UI | React 19, Tailwind CSS 4, Radix UI |
| Auth | [Better Auth](https://www.better-auth.com/) |
| Database | PostgreSQL + [Drizzle ORM](https://orm.drizzle.team/) |
| Storage | S3-compatible object storage |
| Media | Shutter delivery and `pdfjs-dist` |
| Shared libs | `@latch-works/media-domain` |

## Prerequisites

- Node.js 24
- pnpm 12
- PostgreSQL database
- S3-compatible bucket and credentials

## Environment

Pane View validates server environment variables at startup. Create `apps/pane-view/.env` with at least:

```env
DATABASE_URL=postgresql://...
BETTER_AUTH_SECRET=...             # at least 32 characters
BETTER_AUTH_URL=http://127.0.0.1:3000
S3_ENDPOINT=https://...
S3_REGION=auto
S3_BUCKET=...
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
PANE_VIEW_USERNAME=...
PANE_VIEW_PASSWORD=...
PANE_VIEW_SYNC_TOKEN=...           # bearer token for Lockstep, at least 16 characters
SHUTTER_EDGE_URL=https://...       # all SHUTTER_* optional together; see below
SHUTTER_CONTROL_URL=https://...
SHUTTER_SPACE_ID=...
SHUTTER_RESOLVER_ID=...            # optional; the Space's S3 resolver for the originals bucket (v2)
SHUTTER_SPACE_API_TOKEN=...        # Shutter control-plane token
SHUTTER_CAPABILITY_KEYS=...        # Shutter capability-key registry
SHUTTER_CAPABILITY_KID=...
```

Shutter is all or nothing. With every `SHUTTER_*` variable unset, Pane View runs in pass-through
mode: thumbnails and previews are signed original URLs served directly from S3 storage (no
resized variants; video/PDF tiles show placeholders) and there is nothing for maintenance to
purge. Set one and all but `SHUTTER_RESOLVER_ID` are required, and the capability key must be
active for the Space: the server refuses to start on a partial configuration and names what is
missing. `/api/health` reports the active mode in its `variants` field.

With Shutter on and `SHUTTER_RESOLVER_ID` set, thumbnails and previews are v2 Delivery URLs
(`/v2/{space}/{resolver}/{shard_a}/{shard_b}/{object}?token=…`): Shutter reads the
originals bucket through the S3 resolver configured on the Space (read-only key,
key template `originals/sha256/{shard_a}/{shard_b}/{object}`) and Pane View only
issues an access token per URL. Without it, Pane View presigns a locator per
request and seals it into a Source Capability (the v1 flow). The Shutter purge
queue records each original's key so a v2 source can be purged after its media
row is gone. A purge covers both the resolver source and the SHA-256 whenever the
key is known, so what Shutter cached under either API is dropped; sources queued
before that column existed are purged by SHA-256. `/api/health` reports `shutterApi`
as `v2` or `v1`.

`LOCKSTEP_API_TOKEN` on the CLI side should match `PANE_VIEW_SYNC_TOKEN`.

## Development

From the **repo root**:

```powershell
pnpm install
pnpm --filter @latch-works/pane-view dev
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

Migrations that rewrite or delete data say so in their header; back up the database before
applying them to an existing archive. On Railway, every deploy runs `pnpm db:migrate` before the
new version starts (`.railway/railway.ts`), so deploying a version that adds such a migration
applies it: take the backup before you deploy, not after.

> **Back up before deploying `0022_drop_dead_schema`.** Deploying the version that adds it runs
> it, and it destroys data that cannot be rebuilt from the schema. It drops the `api_tokens`,
> `sources`, `collections`, `collection_items`, and `favorites` tables with any rows they hold,
> and columns nothing reads (among them `media_objects.width/height/duration_ms/page_count`,
> `library_entries.sha256/size/metadata`, and `users.password_hash/role`). It deletes rows that
> hold a removed enum value (`legacy_derivative_cleanup` maintenance jobs and `update`/`keep` sync
> run items) and viewer state for `collection` subjects or for entries that no longer exist; viewer
> state then follows its entry through a foreign key. It also rewrites hard-wipe progress written
> before the Shutter-only architecture. While the migration runs, the old version keeps serving
> and its queries name the dropped columns, so requests fail until the new version is live. The
> file header lists every change.

`0021_lowercase_sha256` rewrites rows as well as the schema, so back up the database before
applying it to an existing archive. It lowercases the stored SHA-256 hashes in `media_objects`,
`library_entries`, and `shutter_source_cleanup`, then adds CHECK constraints that reject any
other spelling. Media rows whose hashes differ only in case are merged into one: the row already
in lowercase is kept (otherwise the oldest), library entries and sync history move to it, and
the other row is deleted. Queued Shutter sources are merged the same way and stay unpurged if
any of the merged rows was. When every stored hash is already lowercase it changes no rows. To
check beforehand, run `select count(*) from media_objects where sha256 <> lower(sha256)`.

### Scripts

| Script | Description |
| --- | --- |
| `pnpm dev` | Vite dev server |
| `pnpm build` | Production build |
| `pnpm start` | Run built server (`.output/server`) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Vitest |

## Syncing content

Use [Lockstep](../../apps/lockstep-cli) to publish a local folder tree:

```powershell
# From repo root
$env:LOCKSTEP_API_URL = "http://127.0.0.1:3000"
$env:LOCKSTEP_API_TOKEN = "your-sync-token"
pnpm --filter @latch-works/lockstep start push --source "T:\cloud-desktop\media"
```

Start with `plan` (read-only) or `doctor` to verify connectivity before pushing.

## Project structure

```text
src/
├── routes/              # TanStack Router pages and API routes; _authed/ holds owner-only pages
├── features/            # Browser code, server functions, and each feature's contract
│                        #   (server/ only through import(); an oxlint rule enforces it)
│   ├── library/         # Listing contract, listing/snapshot server functions, query keys
│   ├── gallery/         # Grid, sidebar, browse state and session
│   ├── viewer/          # Media viewer, video player, PDF viewer, comic reader, viewer state
│   ├── delivery/        # Delivery contract, the client URL cache, image components
│   ├── management/      # Maintenance screen, its server functions and contract
│   ├── stats/           # Archive statistics screen
│   └── settings/        # Theme, hotkeys, preferences
├── server/              # Server-only modules, loaded lazily by server functions
│   ├── auth/            # Better Auth, session, sync token, login throttle
│   ├── db/              # Drizzle schema, coordination locks, and the sync/maintenance guards
│   ├── library/         # Listing SQL (keyset paging, comic grouping)
│   ├── media/           # Source Object storage, Shutter, delivery resolution
│   ├── management/      # Maintenance jobs, folder delete, library wipe
│   └── sync/            # The Lockstep sync API (parsed with @latch-works/sync-protocol) and sync runs
└── components/ui/       # Shared UI primitives
```

## Related docs

- [Lockstep runbook](../../docs/runbooks/lockstep.md)
- [Architecture](../../docs/ARCHITECTURE.md)
- Shutter configuration is documented in the repository architecture and `docs/localhost/latch-works.env.example`.
