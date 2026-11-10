/*
 * Conformance vectors for lockstep-core. Oriel's Rust port (apps/oriel/crates/core-sync)
 * must produce the same, so a plan, a hash cache, a scan, prune's safety check, the doctor's
 * checks and the requests cannot drift between the Lockstep CLI and Oriel's Sync (plan 063,
 * "Keeping two implementations honest").
 *
 * This suite checks that the TypeScript still makes the committed vectors in
 * apps/oriel/conformance/lockstep-core, and `cargo test -p oriel-core-sync` checks the Rust
 * against the same files. After a deliberate change, regenerate them and port the change:
 *
 *   ORIEL_UPDATE_VECTORS=1 pnpm --filter @latch-works/lockstep-core test
 */
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { committedVectors, expectCommitted } from "@latch-works/conformance";
import {
  detectMediaType,
  getBaseName,
  getExtension,
  getParentPath,
  ImageExtensions,
  type MediaItem,
  PdfExtensions,
  VideoExtensions,
} from "@latch-works/media-domain";
import {
  CompleteObjectRequestSchema,
  CompleteSyncRunRequestSchema,
  CreateSyncRunRequestSchema,
  completeSyncRunRoute,
  contentTypeForExtension,
  DeleteObjectRequestSchema,
  MAX_SYNC_UPLOAD_BYTES,
  originalObjectKey,
  type RemoteEntry,
  SYNC_ROUTES,
  UploadUrlRequestSchema,
} from "@latch-works/sync-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { isListingReusable } from "./directory-alias-index.js";
import { doctor } from "./doctor.js";
import { HashCache, hashCachePath, loadHashCache } from "./hash-cache.js";
import { selectPlanningHashPaths } from "./plan-sync.js";
import { pruneDeleted } from "./prune-deleted.js";
import {
  plannedDeletes,
  plannedUploads,
  resolveLocalFilePath,
  resolveUploadConcurrency,
} from "./push-helpers.js";
import {
  CREATE_SYNC_RUN_CANCEL_GRACE_MS,
  completeObjectBody,
  createSyncRunBody,
  FINALIZE_ATTEMPT_TIMEOUT_MS,
  FINALIZE_RETRY_DELAYS_MS,
  uploadUrlBody,
} from "./remote-api.js";
import { parseSnapshotResponse } from "./remote-snapshot.js";
import {
  type ArchiveFileFingerprint,
  escapesRoot,
  fingerprintsMatch,
  type ScanArchiveResult,
  scanArchive,
} from "./scan.js";
import { createSyncPlan } from "./sync-plan.js";
import { outcomeBody, type RunAction, type RunOutcome } from "./sync-run.js";
import { type FakePaneView, startFakePaneView } from "./testing.js";
import type { LockstepPlan, LockstepRunEvent } from "./types.js";

function vectorFile(name: string) {
  return { name, set: "lockstep-core" };
}

const ABOUT =
  "Written by packages/lockstep-core/src/conformance.test.ts; ORIEL_UPDATE_VECTORS=1 rewrites it.";

/* A scanned file as the plan sees it: the scan's fields, and a hash when one is known. */
function mediaItem(path: string, size: number, sha256?: string): MediaItem {
  const name = getBaseName(path);

  return {
    extension: getExtension(name),
    id: sha256 ?? path,
    mediaType: detectMediaType(name),
    mtimeMs: 1_700_000_000_000,
    name,
    parentPath: getParentPath(path),
    path,
    sha256,
    size,
  };
}

const SHA_A = "a".repeat(64);

const SHA_B = "b".repeat(64);

const SHA_C = "c".repeat(64);

/* plan.json: createSyncPlan and what push, prune and hashing take from a plan. */

const LocalSchema = z.object({
  path: z.string(),
  size: z.number(),
  sha256: z.string().optional(),
});

const RemoteSchema = z.object({
  path: z.string(),
  size: z.number(),
  sha256: z.string().optional(),
});

const PlanItemSchema = z.object({
  action: z.enum(["delete", "keep", "update", "upload"]),
  path: z.string(),
  localPath: z.string().optional(),
  localSize: z.number().optional(),
  remotePath: z.string().optional(),
});

const SelectionSchema = z.object({
  maxChanges: z.number().optional(),
  paths: z.array(z.string()),
  omittedCount: z.number(),
});

const PlanCaseSchema = z.object({
  name: z.string(),
  local: z.array(LocalSchema),
  remote: z.array(RemoteSchema),
  items: z.array(PlanItemSchema),
  counts: z.object({
    delete: z.number(),
    keep: z.number(),
    update: z.number(),
    upload: z.number(),
  }),
  hashPaths: z.object({ all: z.array(z.string()), remoteAware: z.array(z.string()) }),
  push: z.array(SelectionSchema),
  prune: z.array(SelectionSchema),
  plannedLocalPaths: z.array(z.string()),
});

const PlanVectorsSchema = z.object({ about: z.string(), cases: z.array(PlanCaseSchema) });

type PlanCase = z.infer<typeof PlanCaseSchema>;

const PLAN_INPUTS: Array<Pick<PlanCase, "local" | "name" | "remote">> = [
  { name: "nothing on either side", local: [], remote: [] },
  {
    name: "a first push uploads everything",
    local: [
      { path: "a.jpg", size: 10 },
      { path: "folder/b.png", size: 20 },
      { path: "folder/nested/c.mp4", size: 30 },
    ],
    remote: [],
  },
  {
    name: "matching paths and sizes keep, whatever one side's hash",
    local: [
      { path: "a.jpg", size: 10 },
      { path: "b.jpg", size: 20, sha256: SHA_B },
      { path: "c.jpg", size: 30, sha256: SHA_C },
    ],
    remote: [
      { path: "a.jpg", size: 10, sha256: SHA_A },
      { path: "b.jpg", size: 20 },
      { path: "c.jpg", size: 30, sha256: SHA_C },
    ],
  },
  {
    name: "a different size or hash updates",
    local: [
      { path: "grown.jpg", size: 11 },
      { path: "edited.jpg", size: 20, sha256: SHA_B },
      { path: "same-size.jpg", size: 30 },
    ],
    remote: [
      { path: "grown.jpg", size: 10, sha256: SHA_A },
      { path: "edited.jpg", size: 20, sha256: SHA_A },
      { path: "same-size.jpg", size: 30, sha256: SHA_C },
    ],
  },
  {
    name: "case, Unicode and jpeg spellings pair with the remote path",
    local: [
      { path: "Photos/IMG_1.JPEG", size: 10 },
      { path: "Café/menu.png", size: 20 },
      { path: "Mixed/Case.MP4", size: 31 },
    ],
    remote: [
      { path: "photos/img_1.jpg", size: 10 },
      { path: "Café/menu.png", size: 20 },
      { path: "mixed/case.mp4", size: 30 },
    ],
  },
  {
    name: "a key two locals claim pairs neither",
    local: [
      { path: "a/Photo.jpg", size: 10 },
      { path: "a/photo.jpg", size: 10 },
    ],
    remote: [{ path: "a/PHOTO.jpg", size: 10 }],
  },
  {
    name: "an alias twin left over after its sibling paired is a delete",
    local: [{ path: "x.jpg", size: 10 }],
    remote: [
      { path: "x.jpeg", size: 10 },
      { path: "x.jpg", size: 10 },
    ],
  },
  {
    name: "a moved file is an upload and a delete",
    local: [
      { path: "new/a.png", size: 10 },
      { path: "keep.png", size: 5 },
    ],
    remote: [
      { path: "old/a.png", size: 10 },
      { path: "keep.png", size: 5 },
      { path: "gone/z.mp4", size: 99 },
    ],
  },
  {
    name: "an empty source deletes everything remote",
    local: [],
    remote: [
      { path: "b.jpg", size: 2 },
      { path: "a.jpg", size: 1 },
    ],
  },
  {
    name: "a mixed plan caps push and prune in plan order",
    local: [
      { path: "u1.jpg", size: 1 },
      { path: "k1.jpg", size: 2, sha256: SHA_A },
      { path: "d1.jpg", size: 3 },
      { path: "u2.jpg", size: 4 },
      { path: "same.jpg", size: 5 },
    ],
    remote: [
      { path: "k1.jpg", size: 2, sha256: SHA_A },
      { path: "d1.jpg", size: 4, sha256: SHA_B },
      { path: "same.jpg", size: 5, sha256: SHA_C },
      { path: "r1.jpg", size: 6 },
      { path: "r2.jpg", size: 7 },
      { path: "r3.jpg", size: 8 },
    ],
  },
  {
    name: "case, extension aliases and separators pair",
    local: [
      { path: "Photos/IMG_1.JPG", size: 1 },
      { path: "clips/Clip.MP4", size: 2 },
      { path: "a.jpeg", size: 3 },
    ],
    remote: [
      { path: "photos/img_1.jpg", size: 1 },
      { path: "Clips\\clip.mp4", size: 2 },
      { path: "a.jpg", size: 3 },
    ],
  },
  {
    name: "a case twin left after its sibling paired is deleted",
    local: [{ path: "x.jpg", size: 1 }],
    remote: [
      { path: "x.jpg", size: 1 },
      { path: "X.JPG", size: 1 },
    ],
  },
  {
    name: "an exact path wins over an alias",
    local: [
      { path: "p.jpg", size: 1 },
      { path: "p.jpeg", size: 2 },
    ],
    remote: [
      { path: "p.jpeg", size: 2 },
      { path: "p.jpg", size: 1 },
    ],
  },
  {
    name: "a path listed twice locally",
    local: [
      { path: "dup.jpg", size: 1 },
      { path: "dup.jpg", size: 2 },
    ],
    remote: [{ path: "dup.jpg", size: 2 }],
  },
  {
    name: "a trailing slash and a leading slash",
    local: [{ path: "folder/a.jpg", size: 1 }],
    remote: [{ path: "/folder/a.jpg/", size: 1 }],
  },
];

function selection(
  pick: (maxChanges?: number) => { items: Array<{ path: string }>; omittedCount: number },
) {
  return [undefined, 1, 2].map((maxChanges) => {
    const { items, omittedCount } = pick(maxChanges);

    return { maxChanges, omittedCount, paths: items.map((item) => item.path) };
  });
}

function makePlanCase({ local, name, remote }: Pick<PlanCase, "local" | "name" | "remote">) {
  const localItems = local.map((entry) => mediaItem(entry.path, entry.size, entry.sha256));
  const remoteEntries: RemoteEntry[] = remote;
  const plan = createSyncPlan(localItems, remoteEntries);

  return {
    name,
    local,
    remote,
    items: plan.items.map((item) => ({
      action: item.action,
      path: item.path,
      localPath: item.local?.path,
      localSize: item.local?.size,
      remotePath: item.remote?.path,
    })),
    counts: plan.counts,
    hashPaths: {
      all: [...selectPlanningHashPaths("all", localItems, remoteEntries)],
      remoteAware: [...selectPlanningHashPaths("remote-aware", localItems, remoteEntries)],
    },
    push: selection((maxChanges) => plannedUploads(plan, maxChanges)),
    prune: selection((maxChanges) => plannedDeletes(plan, maxChanges)),
    plannedLocalPaths: plan.items
      .filter((item) => item.action !== "delete")
      .map((item) => item.path),
  };
}

/* rules.json: the small rules push and the doctor apply. */

const RulesVectorsSchema = z.object({
  about: z.string(),
  contentTypes: z.array(z.object({ extension: z.string(), contentType: z.string() })),
  registrations: z.array(
    z.object({
      logicalPath: z.string(),
      filename: z.string(),
      extension: z.string(),
      contentType: z.string(),
    }),
  ),
  uploadConcurrency: z.array(
    z.object({ value: z.number().optional(), resolved: z.number().nullable() }),
  ),
  localPaths: z.array(z.object({ archivePath: z.string(), resolved: z.string().nullable() })),
});

type RulesVectors = z.infer<typeof RulesVectorsSchema>;

/* Every media extension, plus a spelling and an extension the table does not hold. */
const CONTENT_TYPE_EXTENSIONS = [
  ...ImageExtensions,
  ...VideoExtensions,
  ...PdfExtensions,
  "JPG",
  "",
];

const REGISTRATION_PATHS = [
  "a.jpg",
  "folder/Photo.JPEG",
  "deep/er/clip.MP4",
  "x/no-extension",
  "x/.hidden.png",
  "Café/résumé.webp",
  "trailing/",
];

const UPLOAD_CONCURRENCIES = [undefined, 1, 3, 8, 0, 9, 2.5, -1];

const LOCAL_PATH_ROOT = "/archive/root";

const LOCAL_PATHS = [
  "a.jpg",
  "folder/b.png",
  "a/./b.jpg",
  "a/../b.jpg",
  "../escape.jpg",
  "a/../../escape.jpg",
  "..cover.jpg",
  "folder/..hidden/c.jpg",
  "/absolute.jpg",
  "",
];

function makeRulesVectors(): RulesVectors {
  return {
    about: ABOUT,
    contentTypes: CONTENT_TYPE_EXTENSIONS.map((extension) => ({
      extension,
      contentType: contentTypeForExtension(extension),
    })),
    registrations: REGISTRATION_PATHS.map((logicalPath) => {
      const filename = getBaseName(logicalPath);
      const extension = getExtension(filename);

      return { logicalPath, filename, extension, contentType: contentTypeForExtension(extension) };
    }),
    uploadConcurrency: UPLOAD_CONCURRENCIES.map((value) => {
      try {
        return { value, resolved: resolveUploadConcurrency(value) };
      } catch {
        return { value, resolved: null };
      }
    }),
    localPaths: LOCAL_PATHS.map((archivePath) => {
      try {
        return { archivePath, resolved: resolveLocalFilePath(LOCAL_PATH_ROOT, archivePath) };
      } catch {
        return { archivePath, resolved: null };
      }
    }),
  };
}

/* hash-cache.json: where each source's cache lives, what a cache file reads as, and saving. */

const CacheEntrySchema = z.object({
  ctimeMs: z.number().optional(),
  mtimeMs: z.number(),
  path: z.string(),
  sha256: z.string(),
  size: z.number(),
});

const SavedCacheSchema = z.object({ entries: z.array(CacheEntrySchema) });

const FingerprintSchema = z.object({
  ctimeMs: z.number().optional(),
  mtimeMs: z.number(),
  size: z.number(),
});

const HashCacheVectorsSchema = z.object({
  about: z.string(),
  cacheRoot: z.string(),
  cachePaths: z.array(z.object({ sourceRoot: z.string(), file: z.string() })),
  reads: z.array(
    z.object({
      name: z.string(),
      sourceRoot: z.string(),
      file: z.string(),
      entries: z.array(CacheEntrySchema).nullable(),
    }),
  ),
  fingerprints: z.array(
    z.object({ left: FingerprintSchema, right: FingerprintSchema, match: z.boolean() }),
  ),
  hydrate: z.object({
    entries: z.array(CacheEntrySchema),
    items: z.array(z.object({ path: z.string(), fingerprint: FingerprintSchema.nullable() })),
    hits: z.number(),
    hashes: z.array(z.string().nullable()),
  }),
  save: z.object({
    sourceRoot: z.string(),
    sets: z.array(
      z.object({ path: z.string(), fingerprint: FingerprintSchema, sha256: z.string() }),
    ),
    retain: z.array(z.string()),
    saved: z.unknown(),
  }),
});

type HashCacheVectors = z.infer<typeof HashCacheVectorsSchema>;

const CACHE_SOURCE_ROOTS = [
  "/Volumes/Archive",
  "/Volumes/Archive/",
  "/Volumes/Archive/./media/..",
  "/Users/someone/Media Ünïcode",
  "/Users/someone/Media Ünı̈code",
  "/",
];

const CACHE_READ_ROOT = "/Volumes/Archive";

/** Each file to read: a cache document, written as `save` writes one, or raw text. */
const CACHE_READS: Array<{ name: string } & ({ document: object } | { text: string })> = [
  {
    name: "a current cache",
    document: {
      entries: [
        {
          ctimeMs: 1_700_000_000_500,
          mtimeMs: 1_700_000_000_000,
          path: "a.jpg",
          sha256: SHA_A,
          size: 1,
        },
        { mtimeMs: 1_700_000_000_000, path: "b/c.png", sha256: SHA_B, size: 2 },
      ],
      sourceRoot: CACHE_READ_ROOT,
      version: 1,
    },
  },
  {
    name: "fractional times are truncated and hashes lower-cased",
    document: {
      entries: [
        {
          ctimeMs: 1_700_000_000_500.75,
          mtimeMs: 1_700_000_000_000.9,
          path: "a.jpg",
          sha256: SHA_A.toUpperCase(),
          size: 3,
        },
      ],
      sourceRoot: `${CACHE_READ_ROOT}/`,
      version: 1,
    },
  },
  {
    name: "another version is rebuilt",
    document: { entries: [], sourceRoot: CACHE_READ_ROOT, version: 2 },
  },
  {
    name: "another source folder is rebuilt",
    document: { entries: [], sourceRoot: "/Volumes/Other", version: 1 },
  },
  {
    name: "a malformed hash is rebuilt",
    document: {
      entries: [{ mtimeMs: 1, path: "a.jpg", sha256: "not-a-hash", size: 1 }],
      sourceRoot: CACHE_READ_ROOT,
      version: 1,
    },
  },
  {
    name: "a negative size is rebuilt",
    document: {
      entries: [{ mtimeMs: 1, path: "a.jpg", sha256: SHA_A, size: -1 }],
      sourceRoot: CACHE_READ_ROOT,
      version: 1,
    },
  },
  { name: "not JSON is rebuilt", text: "{ entries: [" },
];

const FINGERPRINT_PAIRS: Array<[ArchiveFileFingerprint, ArchiveFileFingerprint]> = [
  [
    { ctimeMs: 5, mtimeMs: 10, size: 1 },
    { ctimeMs: 5, mtimeMs: 10, size: 1 },
  ],
  [
    { ctimeMs: 5.9, mtimeMs: 10.9, size: 1 },
    { ctimeMs: 5.1, mtimeMs: 10.2, size: 1 },
  ],
  [
    { ctimeMs: 5, mtimeMs: 10, size: 1 },
    { ctimeMs: 6, mtimeMs: 10, size: 1 },
  ],
  [
    { mtimeMs: 10, size: 1 },
    { ctimeMs: 6, mtimeMs: 10, size: 1 },
  ],
  [
    { mtimeMs: 10, size: 1 },
    { mtimeMs: 11, size: 1 },
  ],
  [
    { mtimeMs: 10, size: 1 },
    { mtimeMs: 10, size: 2 },
  ],
  [
    { ctimeMs: 5, mtimeMs: 10, size: 1 },
    { mtimeMs: 10, size: 1 },
  ],
  [
    { mtimeMs: -1500.5, size: 0 },
    { mtimeMs: -1500.2, size: 0 },
  ],
];

async function makeHashCacheVectors(scratch: string): Promise<HashCacheVectors> {
  const cacheRoot = "/cache/hash-cache/v1";

  const reads = [];

  for (const read of CACHE_READS) {
    const root = join(scratch, "reads");
    const file = hashCachePath(CACHE_READ_ROOT, root);
    const text = "text" in read ? read.text : `${JSON.stringify(read.document, null, 2)}\n`;

    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);

    const { cache, warning } = await loadHashCache({
      cacheRoot: root,
      sourceRoot: CACHE_READ_ROOT,
    });

    let entries: z.infer<typeof CacheEntrySchema>[] | null = null;

    // A cache that read shows its entries by saving them; a rebuilt one starts empty.
    if (warning === undefined) {
      await cache.save();
      entries = SavedCacheSchema.parse(JSON.parse(await readFile(file, "utf8"))).entries;
    }

    await rm(file);
    reads.push({ name: read.name, sourceRoot: CACHE_READ_ROOT, file: text, entries });
  }

  const hydrateEntries = [
    { ctimeMs: 5, mtimeMs: 10, path: "hit.jpg", sha256: SHA_A, size: 1 },
    { ctimeMs: 5, mtimeMs: 10, path: "moved-time.jpg", sha256: SHA_B, size: 1 },
    { mtimeMs: 10, path: "no-ctime.jpg", sha256: SHA_C, size: 1 },
  ];

  const hydrateItems = [
    { path: "hit.jpg", fingerprint: { ctimeMs: 5.4, mtimeMs: 10.2, size: 1 } },
    { path: "moved-time.jpg", fingerprint: { ctimeMs: 5, mtimeMs: 11, size: 1 } },
    { path: "no-ctime.jpg", fingerprint: { ctimeMs: 99, mtimeMs: 10, size: 1 } },
    { path: "unknown.jpg", fingerprint: { mtimeMs: 10, size: 1 } },
    { path: "no-fingerprint.jpg", fingerprint: null },
  ];

  const hydrateCache = new HashCache(
    join(scratch, "hydrate.json"),
    CACHE_READ_ROOT,
    hydrateEntries,
  );

  const hydrated = hydrateCache.hydrate(
    hydrateItems.map((item) => mediaItem(item.path, 1)),
    new Map(
      hydrateItems.flatMap((item) =>
        item.fingerprint ? [[item.path, item.fingerprint] as const] : [],
      ),
    ),
  );

  const sets = [
    { path: "z/last.mp4", fingerprint: { ctimeMs: 7.5, mtimeMs: 20.9, size: 4 }, sha256: SHA_C },
    { path: "a.jpg", fingerprint: { mtimeMs: 10, size: 1 }, sha256: SHA_A.toUpperCase() },
    { path: "B.jpg", fingerprint: { ctimeMs: 3, mtimeMs: 11, size: 2 }, sha256: SHA_B },
    { path: "b.jpg", fingerprint: { ctimeMs: 3, mtimeMs: 12, size: 2 }, sha256: SHA_B },
    { path: "dropped.jpg", fingerprint: { mtimeMs: 1, size: 1 }, sha256: SHA_A },
    { path: "éclair.png", fingerprint: { mtimeMs: 2, size: 2 }, sha256: SHA_A },
    { path: "e.png", fingerprint: { mtimeMs: 2, size: 2 }, sha256: SHA_A },
    { path: "item10.jpg", fingerprint: { mtimeMs: 2, size: 2 }, sha256: SHA_A },
    { path: "item2.jpg", fingerprint: { mtimeMs: 2, size: 2 }, sha256: SHA_A },
  ];

  const retain = sets.flatMap((set) => (set.path === "dropped.jpg" ? [] : [set.path]));
  const savePath = join(scratch, "save", "cache.json");
  const saving = new HashCache(savePath, CACHE_READ_ROOT);

  for (const set of sets) {
    saving.set(set.path, set.fingerprint, set.sha256);
  }

  saving.retain(new Set(retain));
  await saving.save();

  return {
    about: ABOUT,
    cacheRoot,
    cachePaths: CACHE_SOURCE_ROOTS.map((sourceRoot) => ({
      sourceRoot,
      file: hashCachePath(sourceRoot, cacheRoot),
    })),
    reads,
    fingerprints: FINGERPRINT_PAIRS.map(([left, right]) => ({
      left,
      right,
      match: fingerprintsMatch(left, right),
    })),
    hydrate: {
      entries: hydrateEntries,
      items: hydrateItems,
      hits: hydrated.hits,
      hashes: hydrated.items.map((item) => item.sha256 ?? null),
    },
    save: {
      sourceRoot: CACHE_READ_ROOT,
      sets,
      retain,
      saved: JSON.parse(await readFile(savePath, "utf8")),
    },
  };
}

/*
 * scan.json: what the scan lists, skips and fingerprints, in its order, over a tree on disk that
 * exercises every rule: system folders and junk files, unsupported extensions, symlinks to files
 * and folders and to nothing, names that sort differently by code point, by natural order and by
 * locale, dotfiles, and folders named like media. Names differ by more than case, since macOS
 * volumes fold it.
 */

type ScanTreeEntry =
  | { kind: "file"; path: string; content: string; minutes: number }
  | { kind: "directory"; path: string }
  | { kind: "symlink"; path: string; target: string };

/* Every file's mtime is this plus its minutes, three quarters into a second, so truncation shows. */
const SCAN_TREE_EPOCH_SECONDS = Date.UTC(2026, 0, 1, 12, 0, 0) / 1000;

function treeFile(entryPath: string, minutes: number, content = entryPath): ScanTreeEntry {
  return { kind: "file", path: entryPath, content, minutes };
}

const SCAN_TREE: ScanTreeEntry[] = [
  treeFile("root-image.png", 1),
  treeFile("b.jpg", 2),
  treeFile("img10.jpg", 3),
  treeFile("img2.jpg", 4),
  treeFile("Img1.jpg", 5),
  treeFile("Zeta.mp4", 6),
  treeFile("zebra.jpg", 7),
  treeFile("\u00e9clair.webp", 8),
  treeFile("eclair.png", 9),
  treeFile("\u00dcn\u00efcode.jpg", 10),
  treeFile("photo.JPEG", 11),
  treeFile("movie.M4V", 12),
  treeFile("anim.GIF", 13),
  treeFile("scan.pdf", 14),
  treeFile("still.avif", 15),
  treeFile("raw.bmp", 16),
  treeFile("clip.webm", 17),
  treeFile("clip.mov", 18),
  treeFile("photo.heic", 19),
  treeFile(".hidden.jpg", 20),
  treeFile("..cover.jpg", 21),
  treeFile("100%_done.png", 22),
  treeFile("space name.jpg", 23),
  treeFile("comma,name.jpg", 24),
  treeFile("._b.jpg", 25),
  treeFile(".DS_Store", 26),
  treeFile("Thumbs.db", 27),
  treeFile("desktop.ini", 28),
  treeFile("ehthumbs.db", 29),
  treeFile("notes.txt", 30),
  treeFile("README", 31),
  treeFile("archive.zip", 32),
  treeFile("trailing.", 33),
  treeFile("series/01/page-1.jpg", 34, "a much longer page, so sizes differ"),
  treeFile("series/01/page-10.jpg", 35),
  treeFile("series/01/page-2.jpg", 36),
  treeFile("series/02/cover.avif", 37),
  treeFile("series/02/.DS_Store", 38),
  treeFile("deep/a/b/c/clip.mkv", 39),
  treeFile("dir.mp4/inner.png", 40),
  treeFile(".latch-works/view/thumb.webp", 41),
  treeFile("__MACOSX/._x.jpg", 42),
  treeFile(".glazier-holding/held.png", 43),
  treeFile("$RECYCLE.BIN/r.jpg", 44),
  treeFile(".Trashes/t.jpg", 45),
  treeFile("System Volume Information/s.jpg", 46),
  treeFile(".Spotlight-V100/x.png", 47),
  treeFile("10.jpg", 48),
  treeFile("2.jpg", 49),
  treeFile("a.jpg", 50),
  treeFile("A.png", 51),
  treeFile("folder/x.gif", 52),
  treeFile("folder/desktop.ini", 53),
  treeFile("folder/sub/deep.mov", 54),
  treeFile("folder-2/z.jpeg", 55),
  treeFile("Folder B/upper.jpg", 56),
  treeFile("\u00e9t\u00e9/plage.jpg", 57),
  treeFile("zz/a b.jpg", 58),
  treeFile("zz/a-b.jpg", 59),
  treeFile("zz/a_b.jpg", 60),
  treeFile("zz/ab.jpg", 61),
  { kind: "directory", path: "empty" },
  { kind: "symlink", path: "link.jpg", target: "b.jpg" },
  { kind: "symlink", path: "linked-series", target: "series" },
  { kind: "symlink", path: "dangling.png", target: "missing.png" },
];

async function buildScanTree(root: string): Promise<void> {
  for (const entry of SCAN_TREE) {
    const target = join(root, ...entry.path.split("/"));

    switch (entry.kind) {
      case "directory":
        await mkdir(target, { recursive: true });
        break;
      case "file": {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, entry.content);
        const seconds = SCAN_TREE_EPOCH_SECONDS + entry.minutes * 60 + 0.75;
        await utimes(target, seconds, seconds);
        break;
      }

      case "symlink":
        await mkdir(dirname(target), { recursive: true });
        await symlink(entry.target, target);
        break;
      default: {
        const exhaustive: never = entry;
        throw new Error(`Unknown tree entry ${JSON.stringify(exhaustive)}`);
      }
    }
  }
}

/* What a scan found, without the root (a temp folder) or the change times (the clock's). */
function describeScan(result: ScanArchiveResult) {
  return {
    items: result.items,
    skipped: result.skipped,
    skippedEntries: result.skippedEntries,
    fingerprints: [...result.fingerprints]
      .map(([fingerprintPath, { mtimeMs, size }]) => ({ path: fingerprintPath, mtimeMs, size }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
  };
}

async function makeScanVectors(scratch: string) {
  const root = join(scratch, "scan");

  await buildScanTree(root);

  const plain = describeScan(await scanArchive({ sourceRoot: root }));

  const narrow = describeScan(
    await scanArchive({ sourceRoot: root, directoryConcurrency: 1, fileConcurrency: 1 }),
  );

  const wide = describeScan(
    await scanArchive({ sourceRoot: root, directoryConcurrency: 16, fileConcurrency: 16 }),
  );

  // The pools' widths change only how fast a scan goes, never what it finds.
  expect(narrow).toEqual(plain);
  expect(wide).toEqual(plain);

  return {
    about: ABOUT,
    treeEpochSeconds: SCAN_TREE_EPOCH_SECONDS,
    tree: SCAN_TREE,
    scan: plain,
    hashed: describeScan(await scanArchive({ sourceRoot: root, hashFiles: true })),
    escapesRoot: [
      "",
      "a.jpg",
      "..",
      "../a.jpg",
      "../../a",
      "..cover.jpg",
      "...",
      "a/../b",
      "/abs/a.jpg",
      `..${sep}`,
    ].map((relative) => ({ relative, escapes: escapesRoot(relative) })),
  };
}

/*
 * doctor.json: the doctor's checks, with the temp folder as `<root>`. A case with `api` points the
 * doctor at a loopback port, written `<address>`: one nothing listens on, or one that answers the
 * snapshot request with `status` and `body`.
 */

const DoctorApiSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("closed") }),
  z.object({ kind: z.literal("answer"), status: z.number(), body: z.string() }),
]);

type DoctorApi = z.infer<typeof DoctorApiSchema>;

const DoctorVectorsSchema = z.object({
  about: z.string(),
  cases: z.array(
    z.object({
      name: z.string(),
      options: z.object({
        sourceRoot: z.string().optional(),
        apiUrl: z.string().optional(),
        apiToken: z.string().optional(),
      }),
      api: DoctorApiSchema.optional(),
      checks: z.array(
        z.object({ label: z.string(), ok: z.boolean(), detail: z.string().optional() }),
      ),
      ok: z.boolean(),
      summary: z.object({ message: z.string(), status: z.string(), failed: z.number() }),
    }),
  ),
});

type DoctorVectors = z.infer<typeof DoctorVectorsSchema>;

const DOCTOR_CASES: Array<{
  name: string;
  options: { apiToken?: string; apiUrl?: string; sourceRoot?: string };
  api?: DoctorApi;
}> = [
  { name: "nothing configured", options: {} },
  { name: "a source folder alone", options: { sourceRoot: "<root>/archive" } },
  { name: "a source that is a file", options: { sourceRoot: "<root>/file.jpg" } },
  { name: "a missing source", options: { sourceRoot: "<root>/missing" } },
  { name: "a source under a file", options: { sourceRoot: "<root>/file.jpg/inner" } },
  { name: "a URL without a token", options: { apiUrl: "http://127.0.0.1:3100" } },
  { name: "a token without a URL", options: { apiToken: "secret" } },
  {
    name: "a port nothing listens on",
    options: { apiUrl: "http://<address>", apiToken: "secret" },
    api: { kind: "closed" },
  },
  {
    name: "a token Pane View refuses",
    options: { apiUrl: "http://<address>", apiToken: "wrong" },
    api: { kind: "answer", status: 401, body: "Unauthorized" },
  },
  {
    name: "everything answers",
    options: { sourceRoot: "<root>/archive", apiUrl: "http://<address>", apiToken: "secret" },
    api: {
      kind: "answer",
      status: 200,
      body: '{"entries":[{"path":"a.jpg","size":1},{"path":"b.png","size":2}],"status":"ok"}',
    },
  },
];

/** `Server.address()` widens to a pipe name or null; only a bound TCP address is usable. */
const TcpAddressSchema = z.object({ port: z.number() });

async function listenOnLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return `127.0.0.1:${TcpAddressSchema.parse(server.address()).port}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

/** A loopback address for `api`, and how to stop serving it once the case has run. */
async function serveDoctorApi(
  api: DoctorApi,
): Promise<{ address: string; stop: () => Promise<void> }> {
  if (api.kind === "closed") {
    const server = createServer();
    const address = await listenOnLoopback(server);
    await closeServer(server);

    return { address, stop: async () => {} };
  }

  const server = createServer((_request, response) => {
    response.writeHead(api.status, { "content-type": "text/plain" });
    response.end(api.body);
  });

  return { address: await listenOnLoopback(server), stop: () => closeServer(server) };
}

async function makeDoctorVectors(scratch: string): Promise<DoctorVectors> {
  const root = join(scratch, "doctor");
  await mkdir(join(root, "archive"), { recursive: true });
  await writeFile(join(root, "file.jpg"), "x");

  const cases = [];

  for (const { api, name, options } of DOCTOR_CASES) {
    const served = api ? await serveDoctorApi(api) : undefined;
    const address = served?.address ?? "<address>";

    try {
      const result = await doctor({
        apiToken: options.apiToken,
        apiUrl: options.apiUrl?.replace("<address>", address),
        sourceRoot: options.sourceRoot?.replace("<root>", root),
      });

      cases.push({
        name,
        options,
        api,
        checks: result.checks.map((check) => ({
          ...check,
          detail: check.detail?.replaceAll(root, "<root>").replaceAll(address, "<address>"),
        })),
        ok: result.ok,
        summary: {
          failed: result.summary.failed,
          message: result.summary.message ?? "",
          status: result.summary.status,
        },
      });
    } finally {
      await served?.stop();
    }
  }

  return { about: ABOUT, cases };
}

/*
 * prune.json: prune's safety check. Each case plans `local` against `remote`, leaves `tree` in the
 * source folder, and runs the plan's deletes: a delete goes ahead only while its file is still
 * gone. The outcomes hold on any disk, case- or Unicode-sensitive or not: a case never depends on
 * whether the disk tells two spellings apart. `racyListings` pins when a folder listing may be
 * reused.
 */

const PruneTreeEntrySchema = z.object({
  path: z.string(),
  kind: z.enum(["directory", "file", "symlink"]),
});

const PruneVectorsSchema = z.object({
  about: z.string(),
  cases: z.array(
    z.object({
      name: z.string(),
      local: z.array(z.string()),
      remote: z.array(z.string()),
      tree: z.array(PruneTreeEntrySchema),
      deletes: z.array(
        z.object({
          path: z.string(),
          outcome: z.enum(["deleted", "skipped"]),
          reason: z.string().optional(),
        }),
      ),
    }),
  ),
  racyListings: z.array(
    z.object({
      name: z.string(),
      listedAtNs: z.string(),
      modifiedNs: z.string(),
      changedNs: z.string(),
      reused: z.boolean(),
    }),
  ),
});

type PruneVectors = z.infer<typeof PruneVectorsSchema>;

type PruneCase = PruneVectors["cases"][number];

const PRUNE_INPUTS: Array<Pick<PruneCase, "local" | "name" | "remote" | "tree">> = [
  {
    name: "a file still gone is deleted",
    local: ["keep.jpg"],
    remote: ["keep.jpg", "gone/a.jpg"],
    tree: [{ path: "keep.jpg", kind: "file" }],
  },
  {
    name: "a file back at its path is skipped",
    local: [],
    remote: ["back.jpg"],
    tree: [{ path: "back.jpg", kind: "file" }],
  },
  {
    name: "a folder or a link at the path is skipped",
    local: [],
    remote: ["now-folder.jpg", "now-link.jpg"],
    tree: [
      { path: "now-folder.jpg", kind: "directory" },
      { path: "now-link.jpg", kind: "symlink" },
    ],
  },
  {
    name: "a file back in another case is skipped",
    local: [],
    remote: ["Photos/IMG_1.jpg", "Trip/a.png"],
    tree: [
      { path: "photos/img_1.jpg", kind: "file" },
      { path: "TRIP/a.png", kind: "file" },
    ],
  },
  {
    name: "a file back in another Unicode form is skipped",
    local: [],
    remote: ["caf\u00e9.jpg", "\u00c9t\u00e9/plage.jpg"],
    tree: [
      { path: "cafe\u0301.jpg", kind: "file" },
      { path: "E\u0301te\u0301/plage.jpg", kind: "file" },
    ],
  },
  {
    name: "the jpeg twin of a planned jpg is deleted",
    local: ["x.jpg"],
    remote: ["x.jpeg", "x.jpg"],
    tree: [{ path: "x.jpg", kind: "file" }],
  },
  {
    name: "a jpg back for a deleted jpeg is skipped",
    local: [],
    remote: ["y.jpeg", "z.JPG"],
    tree: [
      { path: "y.jpg", kind: "file" },
      { path: "Z.jpeg", kind: "file" },
    ],
  },
  {
    name: "a new twin beside a planned one is skipped",
    local: ["w.jpg"],
    remote: ["w.jpeg", "w.jpg"],
    tree: [
      { path: "w.jpg", kind: "file" },
      { path: "W.JPEG", kind: "file" },
    ],
  },
  {
    name: "folders do not pair across jpeg and jpg",
    local: [],
    remote: ["album.jpeg/a.jpg"],
    tree: [{ path: "album.jpg/a.jpg", kind: "file" }],
  },
  {
    name: "a file in place of its folder does not count",
    local: [],
    remote: ["was-folder/a.jpg"],
    tree: [{ path: "was-folder", kind: "file" }],
  },
];

const RACY_LISTED_AT_NS = 1_700_000_010_000_000_000n;

const RACY_LISTINGS: Array<{ name: string; modifiedAgoNs: bigint; changedAgoNs: bigint }> = [
  {
    name: "a folder unchanged for 10 s",
    modifiedAgoNs: 10_000_000_000n,
    changedAgoNs: 10_000_000_000n,
  },
  {
    name: "a change exactly 3 s before",
    modifiedAgoNs: 3_000_000_000n,
    changedAgoNs: 3_000_000_000n,
  },
  {
    name: "a change just over 3 s before",
    modifiedAgoNs: 3_000_000_001n,
    changedAgoNs: 3_000_000_001n,
  },
  { name: "a change 2.999 s before", modifiedAgoNs: 2_999_000_000n, changedAgoNs: 2_999_000_000n },
  { name: "a recent change time", modifiedAgoNs: 10_000_000_000n, changedAgoNs: 1_000_000_000n },
  { name: "a recent modified time", modifiedAgoNs: 1_000_000_000n, changedAgoNs: 10_000_000_000n },
  {
    name: "times ahead of the clock",
    modifiedAgoNs: -5_000_000_000n,
    changedAgoNs: -5_000_000_000n,
  },
];

async function makePruneTree(root: string, tree: PruneCase["tree"]): Promise<void> {
  const outside = join(dirname(root), "outside.jpg");
  await mkdir(root, { recursive: true });
  await writeFile(outside, "x");

  for (const entry of tree) {
    const path = join(root, entry.path);
    await mkdir(entry.kind === "directory" ? path : dirname(path), { recursive: true });

    if (entry.kind === "file") {
      await writeFile(path, "x");
    } else if (entry.kind === "symlink") {
      await symlink(outside, path);
    }
  }
}

/* Pane View accepts every delete, so only the safety check decides each one. */
async function makePruneCase(
  paneView: FakePaneView,
  caseRoot: string,
  { local, name, remote, tree }: Pick<PruneCase, "local" | "name" | "remote" | "tree">,
): Promise<PruneCase> {
  const sourceRoot = join(caseRoot, "source");
  await makePruneTree(sourceRoot, tree);

  const plan: LockstepPlan = {
    ...createSyncPlan(
      local.map((path) => mediaItem(path, 1)),
      remote.map((path) => ({ path, size: 1 })),
    ),
    skippedEntries: [],
    sourceRoot,
    totalBytes: local.length,
    totalFiles: local.length,
  };

  const outcomes = new Map<string, PruneCase["deletes"][number]>();

  const record = (event: LockstepRunEvent) => {
    if (event.type === "item-success") {
      outcomes.set(event.path, { path: event.path, outcome: "deleted" });
    } else if (event.type === "item-skipped") {
      outcomes.set(event.path, { path: event.path, outcome: "skipped", reason: event.reason });
    }
  };

  await pruneDeleted(
    { apiToken: paneView.apiToken, apiUrl: paneView.apiUrl, plan },
    { onEvent: record },
  );

  const deletes = plan.items.flatMap((item) => (item.action === "delete" ? [item.path] : []));

  return {
    name,
    local,
    remote,
    tree,
    deletes: deletes.map((path) => {
      const outcome = outcomes.get(path);

      if (!outcome) {
        throw new Error(`Prune neither deleted nor skipped ${path}.`);
      }

      return outcome;
    }),
  };
}

async function makePruneVectors(scratch: string): Promise<PruneVectors> {
  const cases = [];
  const paneView = await startFakePaneView();

  try {
    for (const [index, input] of PRUNE_INPUTS.entries()) {
      cases.push(await makePruneCase(paneView, join(scratch, "prune", String(index)), input));
    }
  } finally {
    await paneView.close();
  }

  return {
    about: ABOUT,
    cases,
    racyListings: RACY_LISTINGS.map(({ name, modifiedAgoNs, changedAgoNs }) => {
      const mtimeNs = RACY_LISTED_AT_NS - modifiedAgoNs;
      const ctimeNs = RACY_LISTED_AT_NS - changedAgoNs;

      return {
        name,
        listedAtNs: RACY_LISTED_AT_NS.toString(),
        modifiedNs: mtimeNs.toString(),
        changedNs: ctimeNs.toString(),
        reused: isListingReusable(RACY_LISTED_AT_NS, { ctimeNs, mtimeNs }),
      };
    }),
  };
}

/*
 * wire.json: the bodies a client posts for fixed plan items and outcomes, and what it makes of
 * sample snapshot answers. Pane View's route schemas must accept every body, and a Rust client must
 * post the same.
 */

const WireVectorsSchema = z.object({
  about: z.string(),
  constants: z.object({
    createRunCancelGraceMs: z.number(),
    finalizeAttemptTimeoutMs: z.number(),
    finalizeRetryDelaysMs: z.array(z.number()),
    maxUploadBytes: z.number(),
    routes: z.object({
      completeObject: z.string(),
      completeRun: z.string(),
      runs: z.string(),
      snapshot: z.string(),
      uploadUrl: z.string(),
    }),
  }),
  registrations: z.array(
    z.object({
      name: z.string(),
      item: z.object({
        path: z.string(),
        size: z.number(),
        mtimeMs: z.number(),
        sha256: z.string(),
      }),
      logicalPath: z.string(),
      uploadUrl: UploadUrlRequestSchema,
      completeObject: CompleteObjectRequestSchema,
    }),
  ),
  delete: DeleteObjectRequestSchema,
  createRun: CreateSyncRunRequestSchema,
  finalize: z.array(
    z.object({
      name: z.string(),
      action: z.enum(["prune", "push"]),
      outcome: z.object({
        applied: z.number(),
        capped: z.number(),
        failed: z.number(),
        skipped: z.number(),
        interruption: z.enum(["cancelled", "failed"]).optional(),
      }),
      body: CompleteSyncRunRequestSchema,
    }),
  ),
  snapshots: z.array(
    z.object({
      name: z.string(),
      body: z.string(),
      entries: z
        .array(z.object({ path: z.string(), size: z.number(), sha256: z.string().optional() }))
        .optional(),
      error: z.string().optional(),
    }),
  ),
});

type WireVectors = z.infer<typeof WireVectorsSchema>;

const WIRE_SYNC_RUN_ID = "00000000-0000-4000-8000-000000000001";

const WIRE_REGISTRATIONS = [
  { name: "an upload registers at its own path", path: "a.jpg", remotePath: undefined },
  {
    name: "an update registers at the remote spelling",
    path: "Photos/IMG_1.JPEG",
    remotePath: "photos/img_1.jpg",
  },
  { name: "a PDF", path: "docs/Manual.pdf", remotePath: undefined },
  { name: "an MKV uploads as bytes", path: "clips/take.mkv", remotePath: undefined },
  { name: "a Unicode path", path: "Café/résumé.webp", remotePath: undefined },
];

const WIRE_PLAN: LockstepPlan = {
  ...createSyncPlan(
    [mediaItem("a.jpg", 10), mediaItem("b.png", 20), mediaItem("kept.mp4", 30)],
    [
      { path: "b.png", size: 21 },
      { path: "kept.mp4", size: 30 },
      { path: "gone.jpg", size: 40 },
    ],
  ),
  skippedEntries: [],
  sourceRoot: "/Volumes/Archive",
  totalBytes: 60,
  totalFiles: 3,
};

const WIRE_OUTCOMES: Array<{
  name: string;
  action: RunAction;
  outcome: Omit<RunOutcome, "interruption"> & { interruption?: "cancelled" | "failed" };
}> = [
  {
    name: "a push that applied everything",
    action: "push",
    outcome: { applied: 2, capped: 2, failed: 0, skipped: 0 },
  },
  {
    name: "a push with failed items",
    action: "push",
    outcome: { applied: 1, capped: 2, failed: 1, skipped: 0 },
  },
  {
    name: "a cancelled push",
    action: "push",
    outcome: { applied: 1, capped: 2, failed: 0, skipped: 0, interruption: "cancelled" },
  },
  {
    name: "a prune with a failed delete",
    action: "prune",
    outcome: { applied: 0, capped: 1, failed: 1, skipped: 0 },
  },
  {
    name: "a prune stopped by an error",
    action: "prune",
    outcome: { applied: 0, capped: 1, failed: 0, skipped: 0, interruption: "failed" },
  },
];

const WIRE_SNAPSHOTS = [
  {
    name: "entries with and without hashes",
    body: `{"entries":[{"path":"a.jpg","size":1,"sha256":"${SHA_A}"},{"path":"b.png","size":2}]}`,
  },
  {
    name: "extra fields are ignored",
    body: '{"entries":[{"path":"a.jpg","size":1,"mediaType":"image"}],"status":"ok"}',
  },
  {
    name: "a null or numeric hash is dropped",
    body: '{"entries":[{"path":"a.jpg","size":1,"sha256":null},{"path":"b.jpg","size":2,"sha256":5}]}',
  },
  { name: "no entries array", body: '{"status":"ok"}' },
  { name: "entries that are not an array", body: '{"entries":{}}' },
  { name: "an entry without a size", body: '{"entries":[{"path":"a.jpg"}]}' },
  { name: "an entry that is not an object", body: '{"entries":["a.jpg"]}' },
];

function makeWireVectors(): WireVectors {
  return {
    about: ABOUT,
    constants: {
      createRunCancelGraceMs: CREATE_SYNC_RUN_CANCEL_GRACE_MS,
      finalizeAttemptTimeoutMs: FINALIZE_ATTEMPT_TIMEOUT_MS,
      finalizeRetryDelaysMs: FINALIZE_RETRY_DELAYS_MS,
      maxUploadBytes: MAX_SYNC_UPLOAD_BYTES,
      routes: { ...SYNC_ROUTES, completeRun: completeSyncRunRoute("{syncRunId}") },
    },
    registrations: WIRE_REGISTRATIONS.map(({ name, path, remotePath }) => {
      const item = { ...mediaItem(path, 1234, SHA_A), sha256: SHA_A };
      const logicalPath = remotePath ?? path;
      const uploadUrl = uploadUrlBody(item, logicalPath);

      return {
        name,
        item: { path: item.path, size: item.size, mtimeMs: item.mtimeMs, sha256: item.sha256 },
        logicalPath,
        uploadUrl,
        completeObject: completeObjectBody({
          item,
          logicalPath,
          objectKey: originalObjectKey({
            extension: getExtension(uploadUrl.filename),
            sha256: item.sha256,
          }),
          syncRunId: WIRE_SYNC_RUN_ID,
        }),
      };
    }),
    delete: { action: "delete", logicalPath: "gone.jpg", syncRunId: WIRE_SYNC_RUN_ID },
    createRun: createSyncRunBody(WIRE_PLAN),
    finalize: WIRE_OUTCOMES.map(({ name, action, outcome }) => ({
      name,
      action,
      outcome,
      body: outcomeBody(action, WIRE_PLAN, {
        ...outcome,
        interruption:
          outcome.interruption === "cancelled"
            ? { reason: new Error("Cancelled by SIGINT."), status: "cancelled" }
            : outcome.interruption === "failed"
              ? {
                  error: new Error("Source folder is not available: /Volumes/Archive."),
                  status: "failed",
                }
              : undefined,
      }),
    })),
    snapshots: WIRE_SNAPSHOTS.map(({ name, body }) => {
      try {
        return { name, body, entries: parseSnapshotResponse(body) };
      } catch (error) {
        return { name, body, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  };
}

describe("lockstep-core conformance vectors", () => {
  let scratch: string;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "lockstep-core-vectors-"));
  });

  afterAll(async () => {
    await rm(scratch, { force: true, recursive: true });
  });

  it("plans as the committed plan.json", () => {
    const vectors = { about: ABOUT, cases: PLAN_INPUTS.map(makePlanCase) };
    expect(committedVectors(vectorFile("plan.json"), PlanVectorsSchema, vectors)).toEqual(
      PlanVectorsSchema.parse(vectors),
    );
  });

  it("applies the rules in the committed rules.json", () => {
    const vectors = makeRulesVectors();
    expect(committedVectors(vectorFile("rules.json"), RulesVectorsSchema, vectors)).toEqual(
      RulesVectorsSchema.parse(vectors),
    );
  });

  it("keeps hash caches as the committed hash-cache.json", async () => {
    const vectors = await makeHashCacheVectors(scratch);
    expect(
      committedVectors(vectorFile("hash-cache.json"), HashCacheVectorsSchema, vectors),
    ).toEqual(HashCacheVectorsSchema.parse(vectors));
  });

  it("scans as the committed scan.json", async () => {
    expectCommitted(vectorFile("scan.json"), await makeScanVectors(scratch));
  });

  it("posts the bodies in the committed wire.json", () => {
    const vectors = makeWireVectors();
    expect(committedVectors(vectorFile("wire.json"), WireVectorsSchema, vectors)).toEqual(
      WireVectorsSchema.parse(vectors),
    );
  });

  it("prunes as the committed prune.json", async () => {
    const vectors = await makePruneVectors(scratch);
    expect(committedVectors(vectorFile("prune.json"), PruneVectorsSchema, vectors)).toEqual(
      PruneVectorsSchema.parse(vectors),
    );
  });

  it("checks as the committed doctor.json", async () => {
    const vectors = await makeDoctorVectors(scratch);
    expect(committedVectors(vectorFile("doctor.json"), DoctorVectorsSchema, vectors)).toEqual(
      DoctorVectorsSchema.parse(vectors),
    );
  });
});
