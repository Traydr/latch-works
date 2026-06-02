# Deployment Runbook

## Pane View on Railway

Pane View expects the Railway app service to have these variables before the pre-deploy migration runs:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
SESSION_SECRET=<at least 32 random characters>
PANE_VIEW_USERNAME=<your login username>
PANE_VIEW_PASSWORD=<your login password>
PANE_VIEW_SYNC_TOKEN=<random token for Lockstep>
APP_ORIGIN=https://<your-pane-view-domain>
```

Storage variables are needed before full Lockstep push:

```text
S3_ENDPOINT=<Railway bucket S3 endpoint>
S3_REGION=auto
S3_BUCKET=<bucket name>
S3_ACCESS_KEY_ID=<bucket access key>
S3_SECRET_ACCESS_KEY=<bucket secret key>
MEDIA_URL_MODE=signed-url
```

Use this pre-deploy command from the `apps/pane-view` service root:

```sh
pnpm db:migrate
```

The start command should run the TanStack Start server emitted by `vite build`:

```sh
pnpm start
```

If Railway shows `drizzle-kit migrate` cannot find a PostgreSQL connection, the Pane View service is missing `DATABASE_URL` or it is not referencing the Postgres service.
