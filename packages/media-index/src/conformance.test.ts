/*
 * Conformance vectors for media-index. Oriel's Rust port (apps/oriel/crates/core-index)
 * must produce the same, so the archive scan and the sync plan cannot drift between the two
 * (plan 063, "Keeping two implementations honest"). View's media index (view-index.json and
 * view-index.sqlite) came from Electron Oriel's schema; it is frozen since Electron Oriel was
 * removed, and only the Rust reads it.
 *
 * This suite checks that the TypeScript still makes the committed vectors in
 * apps/oriel/conformance/media-index, and `cargo test -p oriel-core-index` checks the Rust
 * against the same files. After a deliberate change, regenerate them and port the change:
 *
 *   ORIEL_UPDATE_VECTORS=1 pnpm --filter @latch-works/media-index test
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectMediaType,
  getExtension,
  getParentPath,
  type MediaItem,
} from "@latch-works/media-domain";
import { afterAll, describe, expect, it } from "vitest";
import { escapesRoot, fingerprintsMatch, type ScanArchiveResult, scanArchive } from "./scan.js";
import { createSyncPlan, type RemoteEntrySnapshot } from "./sync-plan.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const vectorDirectory = path.join(repositoryRoot, "apps/oriel/conformance/media-index");

const updating = process.env.ORIEL_UPDATE_VECTORS === "1";

const temporaryFolders: string[] = [];

afterAll(() => {
  for (const folder of temporaryFolders) rmSync(folder, { recursive: true, force: true });
});

function temporaryFolder(prefix: string): string {
  const folder = mkdtempSync(path.join(os.tmpdir(), prefix));

  temporaryFolders.push(folder);

  return folder;
}

function about(source: string): string {
  return `Made by packages/media-index/src/conformance.test.ts from ${source}; do not edit. Regenerate with ORIEL_UPDATE_VECTORS=1 pnpm --filter @latch-works/media-index test. Non-ASCII characters are escaped.`;
}

/*
 * Writes JSON as ASCII, which Biome then formats as the repository does, as media-domain's
 * vectors are written.
 */
function writeVectors(file: string, json: string): void {
  const ascii = json.replace(
    /[\u007f-￿]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${ascii}\n`);
  execFileSync("pnpm", ["exec", "biome", "format", "--write", file], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
}

/* Rewrites the file first when updating, then checks that it holds what the TypeScript makes. */
function expectCommitted<T>(fileName: string, vectors: T): void {
  const file = path.join(vectorDirectory, fileName);

  if (updating) writeVectors(file, JSON.stringify(vectors));

  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(vectors);
}

/* scan.ts */

type TreeEntry =
  | { kind: "file"; path: string; content: string; minutes: number }
  | { kind: "directory"; path: string }
  | { kind: "symlink"; path: string; target: string };

/* Every file's mtime is this plus its minutes, three quarters into a second, so truncation shows. */
const TREE_EPOCH_SECONDS = Date.UTC(2026, 0, 1, 12, 0, 0) / 1000;

function file(entryPath: string, minutes: number, content = entryPath): TreeEntry {
  return { kind: "file", path: entryPath, content, minutes };
}

/*
 * A tree that exercises every rule: system folders and junk files, unsupported extensions,
 * symlinks to files and folders and to nothing, names that sort differently by code point, by
 * natural order and by locale, dotfiles, and folders named like media. Names differ by more than
 * case, since macOS volumes fold it.
 */
const tree: TreeEntry[] = [
  file("root-image.png", 1),
  file("b.jpg", 2),
  file("img10.jpg", 3),
  file("img2.jpg", 4),
  file("Img1.jpg", 5),
  file("Zeta.mp4", 6),
  file("zebra.jpg", 7),
  file("éclair.webp", 8),
  file("eclair.png", 9),
  file("Ünïcode.jpg", 10),
  file("photo.JPEG", 11),
  file("movie.M4V", 12),
  file("anim.GIF", 13),
  file("scan.pdf", 14),
  file("still.avif", 15),
  file("raw.bmp", 16),
  file("clip.webm", 17),
  file("clip.mov", 18),
  file("photo.heic", 19),
  file(".hidden.jpg", 20),
  file("..cover.jpg", 21),
  file("100%_done.png", 22),
  file("space name.jpg", 23),
  file("comma,name.jpg", 24),
  file("._b.jpg", 25),
  file(".DS_Store", 26),
  file("Thumbs.db", 27),
  file("desktop.ini", 28),
  file("ehthumbs.db", 29),
  file("notes.txt", 30),
  file("README", 31),
  file("archive.zip", 32),
  file("trailing.", 33),
  file("series/01/page-1.jpg", 34, "a much longer page, so sizes differ"),
  file("series/01/page-10.jpg", 35),
  file("series/01/page-2.jpg", 36),
  file("series/02/cover.avif", 37),
  file("series/02/.DS_Store", 38),
  file("deep/a/b/c/clip.mkv", 39),
  file("dir.mp4/inner.png", 40),
  file(".latch-works/view/thumb.webp", 41),
  file("__MACOSX/._x.jpg", 42),
  file(".glazier-holding/held.png", 43),
  file("$RECYCLE.BIN/r.jpg", 44),
  file(".Trashes/t.jpg", 45),
  file("System Volume Information/s.jpg", 46),
  file(".Spotlight-V100/x.png", 47),
  { kind: "directory", path: "empty" },
  { kind: "symlink", path: "link.jpg", target: "b.jpg" },
  { kind: "symlink", path: "linked-series", target: "series" },
  { kind: "symlink", path: "dangling.png", target: "missing.png" },
];

function buildTree(root: string, entries: readonly TreeEntry[]): void {
  for (const entry of entries) {
    const target = path.join(root, ...entry.path.split("/"));

    switch (entry.kind) {
      case "directory":
        mkdirSync(target, { recursive: true });
        break;
      case "file": {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, entry.content);
        const seconds = TREE_EPOCH_SECONDS + entry.minutes * 60 + 0.75;
        utimesSync(target, seconds, seconds);
        break;
      }

      case "symlink":
        mkdirSync(path.dirname(target), { recursive: true });
        symlinkSync(entry.target, target);
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

async function makeScanVectors() {
  const root = temporaryFolder("media-index-conformance-");

  buildTree(root, tree);

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
    about: about("scan.ts"),
    treeEpochSeconds: TREE_EPOCH_SECONDS,
    tree,
    scan: plain,
    hashed: describeScan(await scanArchive({ sourceRoot: root, hashFiles: true })),
    fingerprintsMatch: [
      [
        { mtimeMs: 1000.9, size: 1 },
        { mtimeMs: 1000.1, size: 1 },
      ],
      [
        { mtimeMs: 1000, size: 1 },
        { mtimeMs: 1001, size: 1 },
      ],
      [
        { mtimeMs: 1000, size: 1 },
        { mtimeMs: 1000, size: 2 },
      ],
      [
        { ctimeMs: 5.5, mtimeMs: 1000, size: 1 },
        { ctimeMs: 5.1, mtimeMs: 1000, size: 1 },
      ],
      [
        { ctimeMs: 5, mtimeMs: 1000, size: 1 },
        { ctimeMs: 6, mtimeMs: 1000, size: 1 },
      ],
      [
        { ctimeMs: 5, mtimeMs: 1000, size: 1 },
        { mtimeMs: 1000, size: 1 },
      ],
      [
        { mtimeMs: -1500.5, size: 0 },
        { mtimeMs: -1500.2, size: 0 },
      ],
    ].map(([left, right]) => {
      if (left === undefined || right === undefined) throw new Error("a pair has two sides");

      return { left, right, match: fingerprintsMatch(left, right) };
    }),
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
      `..${path.sep}`,
    ].map((relative) => ({ relative, escapes: escapesRoot(relative) })),
  };
}

/* sync-plan.ts */

function local(itemPath: string, size: number, sha256?: string): MediaItem {
  const name = itemPath.slice(itemPath.lastIndexOf("/") + 1);

  const item: MediaItem = {
    id: sha256 ?? itemPath,
    path: itemPath,
    parentPath: getParentPath(itemPath),
    name,
    extension: getExtension(name),
    mediaType: detectMediaType(name),
    size,
    mtimeMs: 1767268800000,
  };

  if (sha256 !== undefined) item.sha256 = sha256;

  return item;
}

function remote(entryPath: string, size: number, sha256?: string): RemoteEntrySnapshot {
  const entry: RemoteEntrySnapshot = { path: entryPath, size };

  if (sha256 !== undefined) entry.sha256 = sha256;

  return entry;
}

const syncCases: { name: string; local: MediaItem[]; remote: RemoteEntrySnapshot[] }[] = [
  { name: "nothing on either side", local: [], remote: [] },
  {
    name: "a first push uploads everything",
    local: [local("a.jpg", 1), local("b/c.png", 2)],
    remote: [],
  },
  {
    name: "keeps, updates by size and updates by hash",
    local: [local("a.jpg", 10, "h1"), local("b.jpg", 20), local("c.jpg", 30, "h3")],
    remote: [remote("a.jpg", 10, "h1"), remote("b.jpg", 21), remote("c.jpg", 30, "h4")],
  },
  {
    name: "a hash known on one side only keeps",
    local: [local("d.jpg", 5), local("e.jpg", 5, "h5")],
    remote: [remote("d.jpg", 5, "h4"), remote("e.jpg", 5)],
  },
  {
    name: "remote entries gone locally are deleted",
    local: [],
    remote: [remote("gone.jpg", 1), remote("also/gone.png", 2)],
  },
  {
    name: "case, extension aliases and separators pair",
    local: [local("Photos/IMG_1.JPG", 1), local("clips/Clip.MP4", 2), local("a.jpeg", 3)],
    remote: [remote("photos/img_1.jpg", 1), remote("Clips\\clip.mp4", 2), remote("a.jpg", 3)],
  },
  {
    name: "composed and decomposed names pair",
    local: [local("Ü.jpg", 1)],
    remote: [remote("Ü.jpg", 1)],
  },
  {
    name: "a case twin left after its sibling paired is deleted",
    local: [local("x.jpg", 1)],
    remote: [remote("x.jpg", 1), remote("X.JPG", 1)],
  },
  {
    name: "an exact path wins over an alias",
    local: [local("p.jpg", 1), local("p.jpeg", 2)],
    remote: [remote("p.jpeg", 2), remote("p.jpg", 1)],
  },
  {
    name: "a path listed twice locally",
    local: [local("dup.jpg", 1), local("dup.jpg", 2)],
    remote: [remote("dup.jpg", 2)],
  },
  {
    name: "a trailing slash and a leading slash",
    local: [local("folder/a.jpg", 1)],
    remote: [remote("/folder/a.jpg/", 1)],
  },
];

function makeSyncPlanVectors() {
  return {
    about: about("sync-plan.ts"),
    cases: syncCases.map((testCase) => {
      const plan = createSyncPlan(testCase.local, testCase.remote);

      return {
        ...testCase,
        plan: {
          counts: plan.counts,
          items: plan.items.map((item) => ({
            action: item.action,
            path: item.path,
            localPath: item.local?.path ?? null,
            localSize: item.local?.size ?? null,
            remotePath: item.remote?.path ?? null,
          })),
        },
      };
    }),
  };
}

describe("media-index conformance vectors", () => {
  it("scans the tree as the committed scan", async () => {
    expectCommitted("scan.json", await makeScanVectors());
  });

  it("plans syncs as the committed plans", () => {
    expectCommitted("sync-plan.json", makeSyncPlanVectors());
  });
});
