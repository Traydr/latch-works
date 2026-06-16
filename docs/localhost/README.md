# Localhost Services

This directory contains a Docker Compose stack for the local services Pane View needs:

- PostgreSQL 16 on `localhost:5432`
- RustFS S3-compatible object storage on `http://127.0.0.1:9000`
- RustFS console on `http://127.0.0.1:9001`
- An init container that creates the `latch-works-media` bucket

RustFS console login defaults to `rustfsadmin` / `rustfsadmin`.

## Start

```bash
cd docs/localhost
cp .env.example .env
docker compose up -d
```

Check service state:

```bash
docker compose ps
```

## Configure Latch Works

From the repo root, copy the app template for a fresh local app environment:

```bash
cp docs/localhost/latch-works.env.example .env
ln -sf ../../.env apps/pane-view/.env
```

If you already have a repo-root `.env`, copy only the `DATABASE_URL` and `S3_*` values from
`docs/localhost/latch-works.env.example`.

Then run Pane View migrations:

```bash
cd apps/pane-view
set -a
. ./.env
set +a
pnpm db:migrate
```

Build workspace packages before starting Pane View:

```bash
cd ../..
pnpm build
pnpm dev:pane
```

`GET http://127.0.0.1:3000/api/health` should return:

```json
{"ok":true,"service":"pane-view"}
```

## Reset Local Data

This deletes the local PostgreSQL and RustFS volumes for this compose project:

```bash
cd docs/localhost
docker compose down -v
```

## Notes

- RustFS is documented as S3-compatible and uses ports `9000` for S3 and `9001` for the console.
- The compose file uses named Docker volumes, so it avoids host directory ownership issues with the
  RustFS container user.
- The credentials in these files are local development defaults only. Do not reuse them outside your
  machine.
