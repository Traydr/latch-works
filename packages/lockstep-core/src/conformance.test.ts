/*
 * Conformance vectors for lockstep-core. Oriel's Rust port (apps/oriel/crates/core-sync)
 * must produce the same, so a plan, a hash cache, a scan and the doctor's checks cannot drift
 * between the Lockstep CLI and Oriel's Sync (plan 063, "Keeping two implementations honest").
 *
 * This suite checks that the TypeScript still makes the committed vectors in
 * apps/oriel/conformance/lockstep-core, and `cargo test -p oriel-core-sync` checks the Rust
 * against the same files. After a deliberate change, regenerate them and port the change:
 *
 *   ORIEL_UPDATE_VECTORS=1 pnpm --filter @latch-works/lockstep-core test
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectMediaType,
  getBaseName,
  getExtension,
  getParentPath,
  type MediaItem,
} from "@latch-works/media-domain";
import {
  type ArchiveFileFingerprint,
  createSyncPlan,
  type DirectoryEntry,
  fingerprintsMatch,
  type RemoteEntrySnapshot,
  scanArchive,
} from "@latch-works/media-index";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { doctor } from "./doctor.js";
import { HashCache, hashCachePath, loadHashCache } from "./hash-cache.js";
import { selectPlanningHashPaths } from "./plan-sync.js";
import { resolveUploadConcurrency } from "./push-changes.js";
import {
  resolveHashMode,
  resolveLocalFilePath,
  selectChangedItems,
  selectDeleteItems,
  selectUploadUpdateItems,
} from "./push-helpers.js";
import { contentTypeForExtension } from "./remote-api.js";
import type { HashMode } from "./types.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const vectorDirectory = fileURLToPath(
  new URL("../../../apps/oriel/conformance/lockstep-core/", import.meta.url),
);

const updating = process.env.ORIEL_UPDATE_VECTORS === "1";

/* Non-ASCII written as escapes, so the files survive any editor's normalization. */
function writeVectors(file: string, json: string) {
  const ascii = json.replace(
    /[\u007f-￿]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${ascii}\n`);
  execFileSync("pnpm", ["exec", "biome", "format", "--write", file], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
}

/* Rewrites the file first when updating, then parses what is committed. */
function committedVectors<T>(fileName: string, schema: z.ZodType<T>, vectors: T): T {
  const file = join(vectorDirectory, fileName);

  if (updating) {
    writeVectors(file, JSON.stringify(vectors));
  }

  return schema.parse(JSON.parse(readFileSync(file, "utf8")));
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
  const remoteEntries: RemoteEntrySnapshot[] = remote;
  const plan = createSyncPlan(localItems, remoteEntries);
  const changed = selectChangedItems(plan.items);

  return {
    name,
    local,
    remote,
    items: plan.items.map((item) => ({
      action: item.action,
      path: item.path,
      localPath: item.local?.path,
      remotePath: item.remote?.path,
    })),
    counts: plan.counts,
    hashPaths: {
      all: [...selectPlanningHashPaths("all", localItems, remoteEntries)],
      remoteAware: [...selectPlanningHashPaths("remote-aware", localItems, remoteEntries)],
    },
    push: selection((maxChanges) => selectUploadUpdateItems(changed, maxChanges)),
    prune: selection((maxChanges) => selectDeleteItems(changed, maxChanges)),
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
  hashModes: z.array(
    z.object({
      hashFiles: z.boolean().optional(),
      hashMode: z.enum(["all", "none", "remote-aware"]).optional(),
      defaultMode: z.enum(["all", "none", "remote-aware"]).optional(),
      resolved: z.enum(["all", "none", "remote-aware"]),
    }),
  ),
  localPaths: z.array(z.object({ archivePath: z.string(), resolved: z.string().nullable() })),
});

type RulesVectors = z.infer<typeof RulesVectorsSchema>;

const CONTENT_TYPE_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "avif",
  "mp4",
  "m4v",
  "webm",
  "mov",
  "pdf",
  "mkv",
  "bmp",
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

const HASH_MODE_INPUTS: Array<{
  defaultMode?: HashMode;
  hashFiles?: boolean;
  hashMode?: HashMode;
}> = [
  {},
  { hashFiles: true },
  { hashFiles: false },
  { hashMode: "remote-aware" },
  { hashMode: "none", hashFiles: true },
  { defaultMode: "remote-aware" },
  { defaultMode: "all", hashFiles: false },
];

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
    hashModes: HASH_MODE_INPUTS.map((input) => ({ ...input, resolved: resolveHashMode(input) })),
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

/* scan.json: what the scan lists and skips, in its order. */

const TreeEntrySchema = z.object({
  path: z.string(),
  kind: z.enum(["directory", "file", "symlink"]),
  size: z.number().optional(),
  mtimeMs: z.number().optional(),
});

const ScanVectorsSchema = z.object({
  about: z.string(),
  tree: z.array(TreeEntrySchema),
  items: z.array(
    z.object({
      path: z.string(),
      parentPath: z.string(),
      name: z.string(),
      extension: z.string(),
      mediaType: z.string(),
      size: z.number(),
      mtimeMs: z.number(),
    }),
  ),
  skippedEntries: z.array(z.object({ path: z.string(), reason: z.string() })),
  skipped: z.number(),
});

type ScanVectors = z.infer<typeof ScanVectorsSchema>;

const SCAN_TREE: z.infer<typeof TreeEntrySchema>[] = [
  { path: "b.jpg", kind: "file", size: 3, mtimeMs: 1_700_000_001_000 },
  { path: "a.jpg", kind: "file", size: 2, mtimeMs: 1_700_000_002_000 },
  { path: "A.png", kind: "file", size: 4, mtimeMs: 1_700_000_003_000 },
  { path: "10.jpg", kind: "file", size: 5, mtimeMs: 1_700_000_004_000 },
  { path: "2.jpg", kind: "file", size: 6, mtimeMs: 1_700_000_005_000 },
  { path: "clip.MP4", kind: "file", size: 7, mtimeMs: 1_700_000_006_000 },
  { path: "doc.pdf", kind: "file", size: 8, mtimeMs: 1_700_000_007_000 },
  { path: "notes.txt", kind: "file", size: 9, mtimeMs: 1_700_000_008_000 },
  { path: ".DS_Store", kind: "file", size: 1, mtimeMs: 1_700_000_009_000 },
  { path: "._a.jpg", kind: "file", size: 1, mtimeMs: 1_700_000_009_000 },
  { path: "Thumbs.db", kind: "file", size: 1, mtimeMs: 1_700_000_009_000 },
  { path: ".hidden.webp", kind: "file", size: 10, mtimeMs: 1_700_000_010_000 },
  { path: "link.jpg", kind: "symlink" },
  { path: "folder", kind: "directory" },
  { path: "folder/x.gif", kind: "file", size: 11, mtimeMs: 1_700_000_011_000 },
  { path: "folder/Y.avif", kind: "file", size: 12, mtimeMs: 1_700_000_012_000 },
  { path: "folder/desktop.ini", kind: "file", size: 1, mtimeMs: 1_700_000_012_000 },
  { path: "folder/sub", kind: "directory" },
  { path: "folder/sub/deep.mov", kind: "file", size: 13, mtimeMs: 1_700_000_013_000 },
  { path: "folder-2", kind: "directory" },
  { path: "folder-2/z.jpeg", kind: "file", size: 14, mtimeMs: 1_700_000_014_000 },
  // Distinct in more than case, since the Rust side builds this tree on a case-insensitive disk.
  { path: "Folder B", kind: "directory" },
  { path: "Folder B/upper.jpg", kind: "file", size: 15, mtimeMs: 1_700_000_015_000 },
  { path: "été", kind: "directory" },
  { path: "été/plage.jpg", kind: "file", size: 16, mtimeMs: 1_700_000_016_000 },
  { path: "zz", kind: "directory" },
  { path: "zz/a b.jpg", kind: "file", size: 17, mtimeMs: 1_700_000_017_000 },
  { path: "zz/a-b.jpg", kind: "file", size: 18, mtimeMs: 1_700_000_018_000 },
  { path: "zz/a_b.jpg", kind: "file", size: 19, mtimeMs: 1_700_000_019_000 },
  { path: "zz/ab.jpg", kind: "file", size: 20, mtimeMs: 1_700_000_020_000 },
  { path: ".latch-works", kind: "directory" },
  { path: ".latch-works/held.jpg", kind: "file", size: 21, mtimeMs: 1_700_000_021_000 },
  { path: "__MACOSX", kind: "directory" },
  { path: "__MACOSX/a.jpg", kind: "file", size: 22, mtimeMs: 1_700_000_022_000 },
  { path: "empty", kind: "directory" },
];

const SCAN_ROOT = "/scan-root";

async function makeScanVectors(): Promise<ScanVectors> {
  const byPath = new Map(SCAN_TREE.map((entry) => [`${SCAN_ROOT}/${entry.path}`, entry]));

  const children = (directory: string): DirectoryEntry[] =>
    SCAN_TREE.flatMap((entry) =>
      dirname(`${SCAN_ROOT}/${entry.path}`) === directory
        ? [
            {
              isDirectory: () => entry.kind === "directory",
              isFile: () => entry.kind === "file",
              name: entry.path.split("/").at(-1) ?? entry.path,
            },
          ]
        : [],
    );

  const result = await scanArchive({
    operations: {
      createReadStream: () => {
        throw new Error("The scan vectors hash nothing.");
      },
      readdir: async (directory) => children(directory),
      stat: async (file) => {
        const entry = byPath.get(file);

        return { ctimeMs: entry?.mtimeMs, mtimeMs: entry?.mtimeMs ?? 0, size: entry?.size ?? 0 };
      },
    },
    sourceRoot: SCAN_ROOT,
  });

  return {
    about: ABOUT,
    tree: SCAN_TREE,
    items: result.items.map((item) => ({
      path: item.path,
      parentPath: item.parentPath,
      name: item.name,
      extension: item.extension,
      mediaType: item.mediaType,
      size: item.size,
      mtimeMs: item.mtimeMs,
    })),
    skippedEntries: result.skippedEntries,
    skipped: result.skipped,
  };
}

/* doctor.json: the doctor's checks that need no server, with the temp folder as `<root>`. */

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
}> = [
  { name: "nothing configured", options: {} },
  { name: "a source folder alone", options: { sourceRoot: "<root>/archive" } },
  { name: "a source that is a file", options: { sourceRoot: "<root>/file.jpg" } },
  { name: "a missing source", options: { sourceRoot: "<root>/missing" } },
  { name: "a source under a file", options: { sourceRoot: "<root>/file.jpg/inner" } },
  { name: "a URL without a token", options: { apiUrl: "http://127.0.0.1:3100" } },
  { name: "a token without a URL", options: { apiToken: "secret" } },
];

async function makeDoctorVectors(scratch: string): Promise<DoctorVectors> {
  const root = join(scratch, "doctor");
  await mkdir(join(root, "archive"), { recursive: true });
  await writeFile(join(root, "file.jpg"), "x");

  const cases = [];

  for (const { name, options } of DOCTOR_CASES) {
    let summary = { failed: -1, message: "", status: "" };

    const result = await doctor(
      { ...options, sourceRoot: options.sourceRoot?.replace("<root>", root) },
      {
        onEvent: (event) => {
          if (event.type === "complete") {
            summary = {
              failed: event.summary.failed,
              message: event.summary.message ?? "",
              status: event.summary.status,
            };
          }
        },
      },
    );

    cases.push({
      name,
      options,
      checks: result.checks.map((check) => ({
        ...check,
        detail: check.detail?.replaceAll(root, "<root>"),
      })),
      ok: result.ok,
      summary,
    });
  }

  return { about: ABOUT, cases };
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
    expect(committedVectors("plan.json", PlanVectorsSchema, vectors)).toEqual(
      PlanVectorsSchema.parse(vectors),
    );
  });

  it("applies the rules in the committed rules.json", () => {
    const vectors = makeRulesVectors();
    expect(committedVectors("rules.json", RulesVectorsSchema, vectors)).toEqual(
      RulesVectorsSchema.parse(vectors),
    );
  });

  it("keeps hash caches as the committed hash-cache.json", async () => {
    const vectors = await makeHashCacheVectors(scratch);
    expect(committedVectors("hash-cache.json", HashCacheVectorsSchema, vectors)).toEqual(
      HashCacheVectorsSchema.parse(vectors),
    );
  });

  it("scans as the committed scan.json", async () => {
    const vectors = await makeScanVectors();
    expect(committedVectors("scan.json", ScanVectorsSchema, vectors)).toEqual(
      ScanVectorsSchema.parse(vectors),
    );
  });

  it("checks as the committed doctor.json", async () => {
    const vectors = await makeDoctorVectors(scratch);
    expect(committedVectors("doctor.json", DoctorVectorsSchema, vectors)).toEqual(
      DoctorVectorsSchema.parse(vectors),
    );
  });
});
