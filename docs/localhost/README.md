# Localhost Services

This directory contains a Docker Compose stack for the local services Pane View needs:

- PostgreSQL 18.4 on `localhost:5432`
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

## Storage cap

The `rustfs-quota` service caps RustFS at about 60 GiB: 50 GiB for the e2e suite's
`latch-works-e2e` bucket and 10 GiB for the dev bucket. A write past a cap fails with "Bucket quota
exceeded". The e2e bucket grows with every test push and nothing empties it, so when it fills,
empty it. Listing it through S3 times out once it holds a few hundred thousand files, so stop RustFS
and remove its objects from the volume:

```bash
docker stop latch-works-localhost-rustfs-1
docker run --rm -v latch-works-localhost_rustfs-data:/data alpine rm -rf /data/latch-works-e2e/originals
docker start latch-works-localhost-rustfs-1
```

The bucket, its CORS rule and its quota stay; the dev bucket is not touched. The next e2e run
seeds what it needs.

## Reset Local Data

This deletes the local PostgreSQL and RustFS volumes for this compose project:

```bash
cd docs/localhost
docker compose down -v
```

If you previously started this stack with the PostgreSQL volume mounted at
`/var/lib/postgresql/data`, run the reset once before starting it again. PostgreSQL 18+ expects the
Docker volume at `/var/lib/postgresql`.

## Notes

- RustFS is documented as S3-compatible and uses ports `9000` for S3 and `9001` for the console.
- The compose file uses named Docker volumes, so it avoids host directory ownership issues with the
  RustFS container user.
- The credentials in these files are local development defaults only. Do not reuse them outside your
  machine.
