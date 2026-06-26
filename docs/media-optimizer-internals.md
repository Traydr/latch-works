# Media Optimizer Internals

How the media optimizer service works end to end: what triggers a run, how jobs are claimed, how bytes move through S3, and which libraries perform image/video conversion.

For deployment and operations, see [runbooks/media-optimizer.md](./runbooks/media-optimizer.md). For the broader derivative pipeline, see [runbooks/pane-view-thumbnails.md](./runbooks/pane-view-thumbnails.md).

## Mental model

The media optimizer is a **stateless CPU worker**. It does not own a queue or talk to the browser.

| Component | Owns |
| --- | --- |
| **Pane View** | `thumbnails` table (derivative queue), auth, CDN token issuance |
| **Media Optimizer** | CPU-heavy generation only |
| **S3 bucket** | Original and derivative bytes |

The optimizer:

1. Gets woken by Pane View
2. **Claims** jobs over authenticated HTTP
3. Reads **originals** from S3, generates **WebP derivatives**, writes them back to S3
4. **Reports** success or failure to Pane View so the DB row becomes `ready` or `failed`

Generation logic lives in `@latch-works/media-derivatives` (shared with Pane View’s `inline` mode). The optimizer app is mostly orchestration around that package.

```mermaid
flowchart LR
  Browser -->|"session"| PV["Pane View"]
  PV -->|"wake + claim API"| MO["Media Optimizer"]
  PV --> PG[(Postgres thumbnails)]
  MO -->|"claim / complete / fail"| PV
  MO <-->|"GET original PUT derivative"| S3["S3 bucket"]
  Browser -->|"CDN token"| CDN["Railway CDN"]
  CDN --> PV
```

---

## What triggers a run?

Pane View wakes the optimizer when derivative rows are `pending` and `DERIVATIVE_PROCESSING_MODE=triggered` (production default on Railway).

### On-demand (gallery browse)

When a user requests a thumbnail that does not exist yet, `ensureThumbnailDerivative` inserts or resets a `pending` row and calls `wakeOptimizer("on-demand")`. Pane View returns `{ status: "pending" }` immediately; the browser polls via batched `resolveMediaDeliveryUrls` until the row is `ready`.

**Source:** `apps/pane-view/src/server/media/derivative-service.ts`

### Post-sync prewarm

After a sync run completes, `prewarmSyncRunDerivatives` enqueues gallery-size (720px) derivatives for newly uploaded or updated image, GIF, and video objects, then wakes the optimizer.

**Source:** `apps/pane-view/src/server/media/derivative-prewarm.ts`

### Wake mechanics

`wakeOptimizer` is fire-and-forget:

- `POST {MEDIA_OPTIMIZER_URL}/internal/optimizer/process`
- `Authorization: Bearer {MEDIA_OPTIMIZER_TOKEN}`
- 4s fetch timeout (optimizer keeps running after timeout)
- 5s cooldown between wakes to prevent stampede from gallery polling

**Source:** `apps/pane-view/src/server/media/optimizer-wake.ts`

---

## HTTP entry point

The optimizer is a small **Hono** app (`apps/media-optimizer`).

| Endpoint | Auth | Behavior |
| --- | --- | --- |
| `GET /health` | None | `{ ok: true, service: "media-optimizer" }` |
| `POST /internal/optimizer/process` | Bearer token | Start background batch; returns `202` |
| `GET /internal/optimizer/status` | Bearer token | `inFlight`, `currentRunId`, `lastRun` counters |

### Single-flight guard

Only one `processBatch` runs at a time. Overlapping `/process` calls return `202 { status: "busy", currentRunId }` without starting a second batch.

**Source:** `apps/media-optimizer/src/server.ts`

### Process lifecycle

```mermaid
sequenceDiagram
  participant PV as Pane View
  participant MO as Media Optimizer

  PV->>MO: POST /internal/optimizer/process
  MO-->>PV: 202 { runId, status: "started" }
  Note over MO: processBatch(runId) runs in background
  loop until empty queue
    MO->>PV: POST /internal/optimizer/claim
    PV-->>MO: jobs + processingToken
    MO->>MO: process each job sequentially
  end
  MO->>MO: store lastRun stats
```

---

## Drain loop and claim chunks

`processBatch` (`apps/media-optimizer/src/processor.ts`) drains the queue until Pane View returns no schedulable jobs. The optimizer has no self-imposed max jobs or max runtime. Railway/serverless lifecycle is the outer stop mechanism; if the platform stops a run, already completed rows stay `ready` and still-leased rows are reclaimed by Pane View after lease expiry.

| Control | Env var | Default |
| --- | --- | --- |
| Jobs leased per claim round | `OPTIMIZER_CLAIM_CHUNK` | 5 |

Each iteration:

1. `claimJobs(OPTIMIZER_CLAIM_CHUNK)` → Pane View
2. Process jobs **strictly one at a time** (concurrency 1)
3. Stop when the claim returns zero jobs

Small claim chunks keep lease exposure bounded if the platform kills a worker mid-run.

---

## Job claiming (Pane View side)

The optimizer calls `POST /internal/optimizer/claim` with `{ limit }`. Pane View runs `claimDerivativeJobs` in a Postgres transaction:

1. `SELECT … FOR UPDATE SKIP LOCKED` on eligible rows:
   - `status = pending` and `next_attempt_at` is due (or null)
   - `status = processing` with expired lease (stale reclaim)
2. `UPDATE` each row → `status = processing`, `processingToken = <uuid>`
3. `JOIN media_objects` and return everything the worker needs

Claims are ordered by Derivative Demand:

1. On-demand previews (`queuePriority = 300`)
2. On-demand thumbnails (`queuePriority = 200`)
3. Prewarm previews (`queuePriority = 100`)
4. Prewarm thumbnails (`queuePriority = 0`)

Within a priority band, newest `priority_at` wins, then newest row creation time. On-demand requests set `priority_at` to request time. Post-sync prewarm uses the newest available library/media timestamp.

### DerivativeJob payload

| Field | Meaning |
| --- | --- |
| `mediaObjectId` | FK into `media_objects` |
| `originalObjectKey` | S3 key for the original (e.g. `originals/sha256/ab/cd/<hash>.jpg`) |
| `objectKey` | S3 key for the derivative (e.g. `thumbnails/sha256/.../<hash>-320.webp`) |
| `sha256`, `extension`, `mediaType`, `size` | Generation inputs |
| `attemptCount` | Retry counter |
| `queueSource`, `queueVariant`, `queuePriority`, `priorityAt` | Priority diagnostics; Pane View already made the claim-order decision |

**Lease:** `processingToken` must match on `complete` / `fail` / `release`. Stale `processing` rows are reclaimable after **10 minutes** (`derivativeProcessingLeaseMs`).

**Sources:** `apps/pane-view/src/server/media/derivative-queue.ts`, `apps/pane-view/src/routes/internal.optimizer.claim.ts`

---

## Per-job processing

```mermaid
sequenceDiagram
  participant MO as Media Optimizer
  participant PV as Pane View
  participant S3 as S3

  MO->>S3: HEAD derivative objectKey
  alt derivative already in S3
    MO->>S3: GET derivative bytes
    MO->>MO: readWebpMetadata (sharp)
    MO->>PV: POST /internal/optimizer/complete
  else generate
    MO->>S3: GET original
    MO->>MO: generateDerivativeBytes
    MO->>S3: PUT derivative (image/webp)
    MO->>PV: POST /internal/optimizer/complete
  end
```

### Step 1: Idempotency check

Before generating, the optimizer `HEAD`s the derivative key. If the object exists (e.g. a prior run wrote S3 but crashed before `complete`), it reads metadata and calls `complete` without regenerating.

### Step 2: Generate bytes

```typescript
const generated = await generateDerivativeBytes({
  size: snapThumbnailSize(job.size),
  source: {
    extension: job.extension,
    mediaType: job.mediaType,
    originalObjectKey: job.originalObjectKey,
    sha256: job.sha256,
  },
  storage,
});

await putStoredObject({
  body: generated.bytes,
  contentType: "image/webp",
  key: job.objectKey,
  storage,
});
```

**Source:** `apps/media-optimizer/src/processor.ts`

### Step 3: Report completion

`POST /internal/optimizer/complete` with `processingToken`, dimensions, and `objectKey`.

Pane View updates the row only if `processingToken` still matches (compare-and-set). `matched: false` (HTTP 409) means the lease was reclaimed — logged as `optimizer.job_stale_lease`.

### On failure

`POST /internal/optimizer/fail` increments `attemptCount`. Pane View either:

- Reschedules with exponential backoff (`pending`, up to 5 attempts), or
- Marks `failed` permanently

---

## Image and video conversion

All conversion lives in `@latch-works/media-derivatives`:

| Dependency | Role |
| --- | --- |
| **sharp** | EXIF rotate, resize, WebP encode, metadata read |
| **ffmpeg-static** | Extract video poster frame |

Pane View does **not** load sharp/ffmpeg in `triggered` mode. The optimizer bundles them via `media-derivatives`.

### Supported types

`supportsDerivative` returns true for `image`, `gif`, and `video`. PDF is not supported yet.

**Source:** `packages/media-derivatives/src/descriptor.ts`

### Images and GIFs

```text
S3 GetObject (original) → Buffer in RAM (max 512 MiB)
  → sharp(input)
      .rotate()
      .resize(size, size, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 90 })
  → WebP Buffer
  → S3 PutObject (derivative)
```

**Source:** `packages/media-derivatives/src/generate.ts`, `packages/media-derivatives/src/image.ts`

### Videos

Videos need a temp file because ffmpeg expects a path on disk:

```text
S3 GetObject (stream) → temp file on disk (byte-limited)
  → ffmpeg -ss 1 -i <temp> -frames:v 1 -q:v 2 poster.jpg
  → sharp(poster.jpg) → WebP
  → S3 PutObject to previews/video/sha256/.../<hash>-<size>.webp
  → delete temp dir
```

**Source:** `packages/media-derivatives/src/video.ts`

### Size ladder

Requested sizes snap to the nearest step: **160, 320, 480, 640, 720, 960, 1080**.

- Gallery grid default: **720** (`GALLERY_THUMBNAIL_SIZE`)
- Fullscreen preview: **1080** (`PREVIEW_DERIVATIVE_SIZE`)

**Source:** `packages/media-delivery/src/thumbnail-size.ts`

---

## S3 object key layout

| Media | Original key | Derivative key |
| --- | --- | --- |
| Image / GIF | `originals/sha256/ab/cd/<hash>.<ext>` | `thumbnails/sha256/ab/cd/<hash>-<size>.webp` |
| Video | `originals/sha256/ab/cd/<hash>.<ext>` | `previews/video/sha256/ab/cd/<hash>-<size>.webp` |

Keys are **content-addressed** (sha256). Folder paths in the archive live only in `library_entries.logical_path`; they are unrelated to S3 keys.

The `objectKey` on each `thumbnails` row is computed at enqueue time via `buildDerivativeDescriptor`.

**Source:** `packages/media-storage/src/index.ts`

Bytes flow **directly** between the optimizer and S3 (AWS SDK). Pane View is not in the data path during generation.

---

## Derivative queue state machine

```text
pending → processing → ready
                    ↘ failed
```

| State | Meaning |
| --- | --- |
| `pending` | Waiting for optimizer claim |
| `processing` | Leased to optimizer (`processingToken` set) |
| `ready` | WebP in S3; browser can get CDN URL |
| `failed` | Generation gave up after max attempts |

In `triggered` mode Pane View **never** runs inline generation — it only enqueues and wakes.

In `inline` mode (local dev default), Pane View generates in-process using the same `generateDerivativeBytes` function; the optimizer is not involved.

---

## After generation: browser delivery

The optimizer does not serve images to users. Once a row is `ready`:

1. Browser calls `resolveMediaDeliveryUrls` (batched server function)
2. Pane View mints an HMAC-signed `/cdn/v1/{token}` URL for the derivative `objectKey`
3. Browser loads the URL; Railway CDN caches the WebP at the edge

See [runbooks/railway-cdn-pane-view.md](./runbooks/railway-cdn-pane-view.md).

---

## Configuration reference

### Media Optimizer (`apps/media-optimizer`)

| Variable | Purpose |
| --- | --- |
| `MEDIA_OPTIMIZER_TOKEN` | Bearer auth for `/internal/*` and Pane View wake |
| `PANE_VIEW_INTERNAL_URL` | Base URL for claim/complete/fail/release |
| `S3_*` | Same bucket as Pane View |
| `OPTIMIZER_CLAIM_CHUNK` | Jobs leased per claim round; the run still drains until empty |
| `PORT` / `MEDIA_OPTIMIZER_PORT` | Listen port (default 3200) |

### Pane View (optimizer-related)

| Variable | Purpose |
| --- | --- |
| `DERIVATIVE_PROCESSING_MODE` | `inline` or `triggered` |
| `MEDIA_OPTIMIZER_URL` | Optimizer base URL for wakes |
| `MEDIA_OPTIMIZER_TOKEN` | Shared secret (must match optimizer) |

---

## Observability

The optimizer emits single-line JSON log events:

| Event | When |
| --- | --- |
| `optimizer.process_requested` | `/process` received |
| `optimizer.claim_start` / `claim_complete` | Claim round |
| `optimizer.job_start` / `job_complete` / `job_failed` | Per job |
| `optimizer.job_stale_lease` | Complete rejected (lease mismatch) |
| `optimizer.batch_complete` | Queue drained and run finished with counters |
| `optimizer.pane_view_request_failed` | Claim/complete HTTP error |

Pane View logs complementary events (`optimizer.wake_requested`, `optimizer.claim`, `optimizer.complete`, etc.) via `derivative-telemetry.ts`.

---

## Design choices

1. **Queue in Postgres, CPU elsewhere** — Pane View is the source of truth; the optimizer is replaceable.
2. **Concurrency 1 per optimizer instance** — limits sharp/ffmpeg memory spikes. Scale horizontally; claims use `SKIP LOCKED`.
3. **Small claim chunks (5)** — if a batch times out, at most 5 jobs need releasing.
4. **Idempotent S3 writes** — content-addressed keys plus HEAD check make retries safe.
5. **Shared generation library** — `generateDerivativeBytes` is identical in inline and triggered modes; only orchestration differs.

---

## Key source files

| Area | Path |
| --- | --- |
| Optimizer HTTP server | `apps/media-optimizer/src/server.ts` |
| Drain loop and per-job flow | `apps/media-optimizer/src/processor.ts` |
| Pane View HTTP client | `apps/media-optimizer/src/pane-view-client.ts` |
| Wake from Pane View | `apps/pane-view/src/server/media/optimizer-wake.ts` |
| Queue claim/complete/fail | `apps/pane-view/src/server/media/derivative-queue.ts` |
| On-demand enqueue | `apps/pane-view/src/server/media/derivative-service.ts` |
| Post-sync prewarm | `apps/pane-view/src/server/media/derivative-prewarm.ts` |
| Generation (sharp/ffmpeg) | `packages/media-derivatives/src/generate.ts` |
| Image resize | `packages/media-derivatives/src/image.ts` |
| Video poster | `packages/media-derivatives/src/video.ts` |
| S3 helpers | `packages/media-storage/src/s3.ts` |
| Object key conventions | `packages/media-storage/src/index.ts` |

## Related docs

- [runbooks/media-optimizer.md](./runbooks/media-optimizer.md) — deployment, env vars, queue diagnostics
- [runbooks/pane-view-thumbnails.md](./runbooks/pane-view-thumbnails.md) — thumbnail pipeline overview
- [ARCHITECTURE.md](./ARCHITECTURE.md) — full system map
- [derivative-prewarm-and-workers.md](./derivative-prewarm-and-workers.md) — pre-warm strategy options
