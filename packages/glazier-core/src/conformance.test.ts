/*
 * Conformance vectors for glazier-core's rules up to changing files. Oriel RS's Rust port
 * (apps/oriel-rs/crates/core-tidy) must produce the same, so sniffing, the junk rules, the keeper,
 * similar groups, duplicate sets with Spot variants, Convert's candidates and Shrink's estimate
 * cannot drift between the two apps (plan 063, "Keeping two implementations honest"). The catalog's
 * schema is pinned the same way, with a catalog made here for Rust to read.
 *
 * This suite checks that the TypeScript still makes the committed vectors in
 * apps/oriel-rs/conformance/glazier-core, and `cargo test -p oriel-core-tidy --test conformance`
 * checks the Rust against the same files. After a deliberate change, regenerate them and port it:
 *
 *   ORIEL_RS_UPDATE_VECTORS=1 pnpm --filter @latch-works/glazier-core exec vitest run \
 *     src/conformance.test.ts
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { isSystemJunkFile } from "@latch-works/media-domain";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { CatalogDatabase } from "./catalog/database.js";
import { initialKind, listFiles, upsertWalkedFiles } from "./catalog/files.js";
import { listRoots, readSettings, writeSettings } from "./catalog/roots.js";
import { catalogTidy } from "./catalog/tidy.js";
import {
  type FileFormat,
  FileFormatSchema,
  FileIdSchema,
  type RootId,
  RootIdSchema,
  type Settings,
  type SimilarityLevel,
  SimilarityLevelSchema,
} from "./contract.js";
import { addDismissal, Dismissals } from "./duplicates/dismissals.js";
import { type KeeperCandidate, rankKeepers } from "./duplicates/keeper.js";
import { computeSimilarClusters } from "./duplicates/queries.js";
import { buildDuplicateSets, pageDuplicateSets } from "./duplicates/sets.js";
import type { JsonValue } from "./engine/engine.js";
import { probeVideo } from "./media/video-probe.js";
import { findOptimizeCandidates, NO_HOLDS, summarizeCandidates } from "./optimize/candidates.js";
import { encodeSpeed } from "./optimize/encode-speed.js";
import { findShrinkCandidates } from "./optimize/shrink.js";
import { extensionFixes } from "./plans/planner.js";
import {
  isExtensionMismatch,
  kindForFormat,
  preferredExtension,
  sniffBytes,
} from "./scan/sniff.js";
import { extensionOf, isFolderSystemFile, type WalkedFile } from "./scan/walk.js";
import { parseFingerprint } from "./similarity/fingerprint.js";
import {
  type FingerprintedFile,
  groupSimilarFiles,
  type SimilarCluster,
} from "./similarity/group.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const VECTORS = path.join(REPO, "apps/oriel-rs/conformance/glazier-core");

const UPDATE = process.env.ORIEL_RS_UPDATE_VECTORS === "1";

const scratch = mkdtempSync(path.join(os.tmpdir(), "glazier-vectors-"));

afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

function about(what: string): string {
  return `Made by packages/glazier-core/src/conformance.test.ts from ${what}; do not edit. Regenerate with ORIEL_RS_UPDATE_VECTORS=1 pnpm --filter @latch-works/glazier-core exec vitest run src/conformance.test.ts. Non-ASCII characters are escaped.`;
}

/* Writes JSON as ASCII, compact, which Biome then formats as the repository does. */
function writeVectors(file: string, value: JsonValue): void {
  const ascii = JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

  writeFileSync(file, `${ascii}\n`);
  execFileSync("pnpm", ["exec", "biome", "format", "--write", file], {
    cwd: REPO,
    stdio: "inherit",
  });
}

const VectorFileSchema = z.object({ about: z.string() }).catchall(z.json());

/* Rewrites the file first when updating, then checks the TypeScript still makes what is committed. */
function expectCommitted<T extends { about: string }>(fileName: string, vectors: T): void {
  const file = path.join(VECTORS, fileName);
  const made = z.json().parse(JSON.parse(JSON.stringify(vectors)));

  if (UPDATE) {
    writeVectors(file, made);
  }

  expect(made).toEqual(VectorFileSchema.parse(JSON.parse(readFileSync(file, "utf8"))));
}

/** A seeded generator, so a regeneration makes the same cases. */
function random(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/* Sniffing: signatures, their near misses, and every format's extensions. */

function ascii(text: string): number[] {
  return [...Buffer.from(text, "latin1")];
}

function ftyp(major: string, ...compatible: string[]): number[] {
  const body = [...ascii(major), 0, 0, 0, 0, ...compatible.flatMap(ascii)];
  const size = 8 + body.length;

  return [
    (size >>> 24) & 255,
    (size >>> 16) & 255,
    (size >>> 8) & 255,
    size & 255,
    ...ascii("ftyp"),
    ...body,
  ];
}

function padded(bytes: number[], length: number, fill = 0): number[] {
  return [...bytes, ...Array.from({ length: Math.max(0, length - bytes.length) }, () => fill)];
}

const SNIFF_INPUTS: number[][] = [
  [],
  [0x89, ...ascii("PNG\r\n\u001a\n")],
  [0x89, ...ascii("PNG\r\n")],
  [0xff, 0xd8, 0xff, 0xe0],
  [0xff, 0xd8],
  ascii("GIF87a"),
  ascii("GIF89a"),
  ascii("GIF88a"),
  [...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBPVP8 ")],
  [...ascii("RIFF"), 0, 0, 0, 0, ...ascii("AVI LIST")],
  [...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVEfmt ")],
  [...ascii("RIFF"), 0, 0, 0, 0, ...ascii("CDXA")],
  [...ascii("RIFF"), 0, 0],
  ftyp("avif", "mif1", "miaf"),
  ftyp("avis", "msf1"),
  ftyp("mif1", "avif"),
  ftyp("mif1", "heic"),
  ftyp("msf1", "avis"),
  ftyp("msf1", "hevc"),
  ftyp("heic", "mif1"),
  ftyp("heix"),
  ftyp("hevc"),
  ftyp("hevx"),
  ftyp("heim"),
  ftyp("heis"),
  ftyp("isom", "iso2", "avc1", "mp41"),
  ftyp("mp42"),
  ftyp("qt  ", "qt  "),
  ftyp("M4A ", "mp42"),
  ftyp("M4B "),
  ftyp("3gp4"),
  // A box that claims to be larger than the bytes read, and one smaller than 16.
  [0, 0, 1, 0, ...ascii("ftypmif1"), 0, 0, 0, 0, ...ascii("avif")],
  [0, 0, 0, 12, ...ascii("ftypmif1"), 0, 0, 0, 0, ...ascii("avif")],
  [0x1a, 0x45, 0xdf, 0xa3, ...ascii("....B\u0082\u0084webm")],
  [0x1a, 0x45, 0xdf, 0xa3, ...ascii("....B\u0082\u0088matroska")],
  padded([0x47], 189, 0x00).map((byte, index) => (index === 188 ? 0x47 : byte)),
  padded([0x47], 188, 0x00),
  ascii("BM6\u0000"),
  ascii("II*\u0000"),
  ascii("MM\u0000*"),
  ascii("8BPS"),
  ascii("%PDF-1.7"),
  ascii("FLV\u0001"),
  [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6],
  [0x50, 0x4b, 0x03, 0x04],
  ascii("Rar!\u001a\u0007"),
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
  ascii("fLaC"),
  ascii("OggS"),
  ascii("ID3\u0004"),
  [0xff, 0xfb, 0x90],
  [0xff, 0xe0],
  [0xff],
  ascii("<svg xmlns='http://www.w3.org/2000/svg'/>"),
  ascii("  \n\t<SVG width='1'/>"),
  [0xa0, ...ascii("<svg/>")],
  ascii("<?xml version='1.0'?>\n<svg/>"),
  ascii("<?xml version='1.0'?><html/>"),
  ascii("<html><svg/></html>"),
  ascii("plain text"),
  [0, 0, 0, 0],
];

const EXTENSIONS = [
  "png",
  "apng",
  "jpg",
  "JPEG",
  "jpe",
  "jfif",
  "gif",
  "webp",
  "bmp",
  "tif",
  "dng",
  "avif",
  "heic",
  "psd",
  "svg",
  "mp4",
  "m4v",
  "mov",
  "mkv",
  "webm",
  "ts",
  "avi",
  "flv",
  "wmv",
  "mp3",
  "m4a",
  "aac",
  "wav",
  "flac",
  "ogg",
  "opus",
  "pdf",
  "zip",
  "cbz",
  "zipmod",
  "rar",
  "r00",
  "7z",
  "001",
  "txt",
  "",
];

describe("glazier-core sniffing vectors", () => {
  it("names formats, extensions and kinds as the committed vectors", () => {
    expectCommitted("sniff.json", {
      about: about("scan/sniff.ts"),
      bytes: SNIFF_INPUTS.map((bytes) => ({
        hex: hex(Uint8Array.from(bytes)),
        format: sniffBytes(Buffer.from(bytes)),
      })),
      formats: FileFormatSchema.options.map((format) => ({
        format,
        kind: kindForFormat(format),
        preferred: preferredExtension(format),
        mismatches: EXTENSIONS.filter((extension) => isExtensionMismatch(format, extension)),
      })),
      extensions: EXTENSIONS,
    });
  });
});

/* The scan's junk rules and the kind a file has before its bytes are read. */

const NAMES = [
  ".DS_Store",
  ".ds_store",
  "desktop.ini",
  "Desktop.INI",
  "Thumbs.db",
  "thumbs.DB",
  "ehthumbs.db",
  "ehthumbs_vista.db",
  "._photo.jpg",
  "._",
  "_photo.jpg",
  ".photo.jpg",
  "photo.jpg",
  "photo.JPG",
  "photo.jpeg",
  "photo.png",
  "photo.gif",
  "photo.webp",
  "photo.bmp",
  "photo.avif",
  "photo.heic",
  "clip.mp4",
  "clip.MOV",
  "clip.mkv",
  "clip.webm",
  "clip.m4v",
  "clip.avi",
  "book.pdf",
  "notes.txt",
  "archive.tar.gz",
  "noextension",
  "trailing.",
  ".hidden",
  "..double",
  "a.b.c.PNG",
  "İmage.PNG",
  "café.JPG",
  "ΣΑΣ.jpg",
];

describe("glazier-core scan rule vectors", () => {
  it("tells junk, extensions and first kinds apart as the committed vectors", () => {
    expectCommitted("scan-rules.json", {
      about: about("scan/walk.ts and catalog/files.ts"),
      names: NAMES.map((name) => ({
        name,
        folderSystemFile: isFolderSystemFile(name),
        systemJunkFile: isSystemJunkFile(name),
        extension: extensionOf(name),
        kind: initialKind(name, false),
        walkedKind: initialKind(name, isSystemJunkFile(name)),
      })),
    });
  });
});

/* The keeper rules, over targeted groups and seeded random ones. */

function keeperCandidate(id: number, overrides: Partial<KeeperCandidate>): KeeperCandidate {
  return {
    id: FileIdSchema.parse(id),
    relPath: `copies/${id}.png`,
    kind: "image",
    format: "png",
    ext: "png",
    extensionMismatch: false,
    videoCodec: null,
    width: 1000,
    height: 1000,
    durationMs: null,
    audioState: null,
    size: 1_000_000,
    mtimeMs: 1_700_000_000_000,
    isPreferred: false,
    inHomeFolder: false,
    ...overrides,
  };
}

const mp4 = { kind: "video", format: "mp4", ext: "mp4", videoCodec: "h264" } as const;

const TARGETED_GROUPS: KeeperCandidate[][] = [
  [keeperCandidate(1, { width: 4000, height: 3000 }), keeperCandidate(2, { isPreferred: true })],
  [
    keeperCandidate(1, { ...mp4, audioState: "none", width: 1920, height: 1080 }),
    keeperCandidate(2, { ...mp4, audioState: "silent", width: 1920, height: 1080 }),
    keeperCandidate(3, { ...mp4, audioState: "sound", width: 1280, height: 720 }),
    keeperCandidate(4, { ...mp4, audioState: "unmeasured", width: 1280, height: 720 }),
  ],
  [keeperCandidate(1, { width: 800, height: 600 }), keeperCandidate(2, {})],
  [
    keeperCandidate(1, { ...mp4, durationMs: 30_000 }),
    keeperCandidate(2, { kind: "video", format: "webm", videoCodec: "vp9", durationMs: 31_000 }),
  ],
  [
    keeperCandidate(1, { ...mp4, durationMs: 30_000 }),
    keeperCandidate(2, { ...mp4, durationMs: 30_249 }),
    keeperCandidate(3, { ...mp4, durationMs: 30_250 }),
  ],
  [keeperCandidate(1, { size: 2_000_000 }), keeperCandidate(2, { format: "avif", size: 300_000 })],
  [
    keeperCandidate(1, { ...mp4, relPath: "misc/loop-0.m4v", ext: "m4v" }),
    keeperCandidate(2, { ...mp4, relPath: "clips/loop-0.mp4", ext: "mp4" }),
  ],
  [
    keeperCandidate(1, { relPath: "a.jpg", ext: "jpg", extensionMismatch: true }),
    keeperCandidate(2, { relPath: "a/b/c.apng", ext: "apng" }),
  ],
  [keeperCandidate(1, { inHomeFolder: true }), keeperCandidate(2, { size: 3_000_000 })],
  [
    keeperCandidate(1, { relPath: "photos/sunset (1).png" }),
    keeperCandidate(2, { relPath: "photos/sunset.png" }),
  ],
  [
    keeperCandidate(1, { relPath: "photos/sunset copy.png" }),
    keeperCandidate(2, { relPath: "photos/sunset copy 2.png" }),
    keeperCandidate(3, { relPath: "photos/sunset.png" }),
    keeperCandidate(4, { relPath: "photos/sunset-copy.png" }),
    keeperCandidate(5, { relPath: "photos/sunset_copy_3.png" }),
    keeperCandidate(6, { relPath: "photos/sunset 2.png" }),
    keeperCandidate(7, { relPath: "photos/SUNSET COPY.png" }),
    keeperCandidate(8, { relPath: "photos/sunset (x).png" }),
    keeperCandidate(9, { relPath: "photos/sunset-copy-.png" }),
  ],
  [
    keeperCandidate(1, { mtimeMs: 1_700_000_000_999.9 }),
    keeperCandidate(2, { mtimeMs: 1_700_000_000_000.1 }),
  ],
  [
    keeperCandidate(1, { relPath: "deep/er/path.png" }),
    keeperCandidate(2, { relPath: "short/path.png" }),
  ],
  [
    keeperCandidate(1, { relPath: "b/photo10.png" }),
    keeperCandidate(2, { relPath: "b/photo9.png" }),
    keeperCandidate(3, { relPath: "b/Photo9.png" }),
    keeperCandidate(4, { relPath: "b/phöto9.png" }),
  ],
  [
    keeperCandidate(1, { relPath: "same/path.png" }),
    keeperCandidate(2, { relPath: "same/path.png" }),
  ],
  [
    keeperCandidate(1, { relPath: "été/café (1).png" }),
    keeperCandidate(2, { relPath: "été/café.png" }),
    keeperCandidate(3, { relPath: "📷/café.png" }),
  ],
  [
    keeperCandidate(1, { kind: "other", format: null, ext: "dat" }),
    keeperCandidate(2, { kind: "audio", format: "mp3", ext: "mp3" }),
  ],
];

const FORMATS_FOR_KEEPERS: Array<{
  kind: KeeperCandidate["kind"];
  format: FileFormat;
  ext: string;
  videoCodec: string | null;
}> = [
  { kind: "image", format: "png", ext: "png", videoCodec: null },
  { kind: "image", format: "jpeg", ext: "jpg", videoCodec: null },
  { kind: "image", format: "jpeg", ext: "jpeg", videoCodec: null },
  { kind: "image", format: "avif", ext: "avif", videoCodec: null },
  { kind: "image", format: "webp", ext: "webp", videoCodec: null },
  { kind: "video", format: "mp4", ext: "mp4", videoCodec: "h264" },
  { kind: "video", format: "mp4", ext: "m4v", videoCodec: "hevc" },
  { kind: "video", format: "mp4", ext: "mp4", videoCodec: "mpeg4" },
  { kind: "video", format: "webm", ext: "webm", videoCodec: "vp9" },
  { kind: "video", format: "mov", ext: "mov", videoCodec: "h264" },
];

const STEMS = ["photo", "photo (1)", "photo copy", "Photo", "photo 2", "photo10", "photo9"];

function randomGroups(): KeeperCandidate[][] {
  const next = random(63);

  const pick = <T>(values: readonly T[]): T => {
    const value = values[Math.floor(next() * values.length)];

    if (value === undefined) {
      throw new Error("Nothing to pick from.");
    }

    return value;
  };

  const groups: KeeperCandidate[][] = [];

  for (let group = 0; group < 200; group += 1) {
    const size = 2 + Math.floor(next() * 4);
    const family = pick(FORMATS_FOR_KEEPERS);

    // Most members share most of what the early rules compare, so the later rules decide too.
    const shared = {
      width: pick([null, 640, 1280, 1920]),
      height: pick([null, 480, 720, 1080]),
      durationMs: pick([null, 10_000, 10_200, 10_300, 60_000]),
      audioState: pick([null, "none", "silent", "sound", "unmeasured"] as const),
      size: pick([1000, 1050, 1100, 2000]),
      mtimeMs: pick([1_600_000_000_000, 1_600_000_000_000.5, 1_700_000_000_000]),
    };

    const members: KeeperCandidate[] = [];
    const often = <T>(value: T, other: () => T): T => (next() < 0.8 ? value : other());

    for (let member = 0; member < size; member += 1) {
      const format = next() < 0.7 ? family : pick(FORMATS_FOR_KEEPERS);
      const ext = next() < 0.1 ? "jpg" : format.ext;
      const folder = pick(["a", "b", "a/b", "deep/er/folder", ""]);
      const name = `${pick(STEMS)}.${ext}`;

      members.push(
        keeperCandidate(group * 10 + member + 1, {
          relPath: folder ? `${folder}/${name}` : name,
          kind: format.kind,
          format: format.format,
          ext,
          extensionMismatch: ext !== format.ext && next() < 0.8,
          videoCodec: format.videoCodec,
          width: often(shared.width, () => pick([null, 640, 1280, 1920])),
          height: often(shared.height, () => pick([null, 480, 720, 1080])),
          durationMs:
            format.kind === "video"
              ? often(shared.durationMs, () => pick([null, 10_250, 60_000]))
              : null,
          audioState:
            format.kind === "video"
              ? often(shared.audioState, () => pick([null, "none", "sound"] as const))
              : null,
          size: often(shared.size, () => pick([1000, 1050, 1100, 2000])),
          mtimeMs: often(shared.mtimeMs, () => pick([1_600_000_000_000, 1_700_000_000_000])),
          isPreferred: next() < 0.05,
          inHomeFolder: next() < 0.1,
        }),
      );
    }

    groups.push(members);
  }

  return groups;
}

describe("glazier-core keeper vectors", () => {
  it("ranks copies as the committed vectors", () => {
    expectCommitted("keeper.json", {
      about: about("duplicates/keeper.ts"),
      groups: [...TARGETED_GROUPS, ...randomGroups()].map((candidates) => {
        const { ranked, reason } = rankKeepers(candidates);

        return { candidates, ranked: ranked.map((entry) => entry.id), reason };
      }),
    });
  });
});

/* Similar groups: synthetic prints near every threshold and aspect bin. */

function hashHex(next: () => number): string {
  return Array.from({ length: 16 }, () => Math.floor(next() * 16).toString(16)).join("");
}

function flipBits(hash: string, bits: number, next: () => number): string {
  let value = BigInt(`0x${hash}`);
  const flipped = new Set<number>();

  while (flipped.size < bits) {
    flipped.add(Math.floor(next() * 64));
  }

  for (const bit of flipped) {
    value ^= 1n << BigInt(bit);
  }

  return value.toString(16).padStart(16, "0");
}

const ASPECTS = [
  1,
  1.0299,
  1.031,
  0.985,
  4 / 3,
  1.3734,
  1.29,
  16 / 9,
  1.8,
  0.75,
  9 / 16,
  2.39,
  0,
  -1,
];

function similarCases(): Array<{
  name: string;
  files: Array<{ id: number; aspect: number; fingerprint: string }>;
}> {
  const next = random(5);

  const cases: Array<{
    name: string;
    files: Array<{ id: number; aspect: number; fingerprint: string }>;
  }> = [];

  for (let index = 0; index < 12; index += 1) {
    const files: Array<{ id: number; aspect: number; fingerprint: string }> = [];
    let id = 1;
    const bases = Array.from({ length: 4 }, () => hashHex(next));

    for (const base of bases) {
      const aspect = ASPECTS[Math.floor(next() * ASPECTS.length)] ?? 1;

      for (let copy = 0; copy < 6; copy += 1) {
        const bits = Math.floor(next() * 15);
        const drift = next() < 0.3 ? (next() - 0.5) * 0.08 : 0;
        files.push({
          id: id++,
          aspect: aspect + drift,
          fingerprint: `s:${flipBits(base, bits, next)}`,
        });
      }
    }

    for (let motion = 0; motion < 3; motion += 1) {
      const frames = Array.from({ length: 5 }, () => hashHex(next));
      const duration = Math.floor(next() * 120_000);

      for (let copy = 0; copy < 4; copy += 1) {
        const durationMs = duration + Math.round((next() - 0.5) * 6000);
        const prints = frames.map((frame) => flipBits(frame, Math.floor(next() * 16), next));
        const count = next() < 0.2 ? 3 : 5;
        files.push({
          id: id++,
          aspect: 16 / 9 + (next() < 0.2 ? 0.05 : 0),
          fingerprint: `m:${durationMs}:${prints.slice(0, count).join(".")}`,
        });
      }
    }

    // Shuffle so the bins fill in no particular order.
    for (let at = files.length - 1; at > 0; at -= 1) {
      const other = Math.floor(next() * (at + 1));
      const left = files[at];
      const right = files[other];

      if (left !== undefined && right !== undefined) {
        files[at] = right;
        files[other] = left;
      }
    }

    cases.push({ name: `seeded ${index}`, files });
  }

  return cases;
}

describe("glazier-core similar group vectors", () => {
  it("groups prints at each level as the committed vectors", async () => {
    const cases = [];

    for (const entry of similarCases()) {
      const files: FingerprintedFile[] = entry.files.map((file) => ({
        id: FileIdSchema.parse(file.id),
        aspect: file.aspect,
        fingerprint: parseFingerprint(file.fingerprint),
      }));

      const levels: Array<readonly [string, SimilarCluster[]]> = [];

      for (const level of SimilarityLevelSchema.options) {
        levels.push([level, await groupSimilarFiles(files, level, async () => undefined)]);
      }

      cases.push({ ...entry, levels: Object.fromEntries(levels) });
    }

    expectCommitted("similar-groups.json", { about: about("similarity/group.ts"), cases });
  });
});

/* Catalogs made of synthetic rows, for the queries that read them. */

const BASE_ROW = {
  root_id: 1,
  dir: "",
  ext: "png",
  size: 100_000,
  mtime_ms: 1_700_000_000_000,
  ctime_ms: 1_700_000_000_000,
  dev: "1",
  is_junk: 0,
  last_seen_scan: 1,
  kind: "image",
  format: "png",
  ext_mismatch: 0,
  probe_version: 1,
  probe_error: null,
  width: 640,
  height: 480,
  frames: 1,
  has_alpha: 0,
  duration_ms: null,
  video_codec: null,
  audio_codec: null,
  audio_streams: null,
  bitrate: null,
  head_hash: null,
  sha256: null,
  fingerprint_version: 1,
  fingerprint: null,
  fingerprint_error: null,
  loudness_version: 0,
  loudness_max_db: null,
  optimize_not_smaller: 0,
  shrink_not_smaller: 0,
};

type CatalogRow = Record<string, string | number | null>;

/** A file row: the base, the path's parts, and what the case sets. */
function row(id: number, relPath: string, overrides: CatalogRow = {}) {
  const slash = relPath.lastIndexOf("/");
  const name = relPath.slice(slash + 1);

  return {
    ...BASE_ROW,
    id,
    rel_path: relPath,
    dir: slash < 0 ? "" : relPath.slice(0, slash),
    name,
    ext: extensionOf(name),
    ino: String(id),
    ...overrides,
  } satisfies CatalogRow;
}

interface SyntheticCatalog {
  name: string;
  settings: Settings;
  rows: CatalogRow[];
  /** Detail prints by file id, as hex; null for a print that failed. */
  details: Array<{ fileId: number; print: string | null }>;
  dismissals: number[][];
  timings: Array<{ pixels: number; mediaMs: number; wallMs: number }>;
}

function openCatalog(entry: SyntheticCatalog): CatalogDatabase {
  const file = path.join(scratch, `${entry.name.replaceAll(/[^a-z0-9]+/gi, "-")}.sqlite`);
  rmSync(file, { force: true });
  const db = new CatalogDatabase(file);
  db.run("INSERT INTO roots (id, path, added_at) VALUES (1, '/archive', 0)");
  db.run("INSERT INTO roots (id, path, added_at) VALUES (2, '/other', 0)");
  writeSettings(db, entry.settings);

  for (const fileRow of entry.rows) {
    const columns = Object.keys(fileRow);

    const params = Object.fromEntries(
      columns.map((column) => [`$${column}`, fileRow[column] ?? null]),
    );

    db.run(
      `INSERT INTO files (${columns.join(", ")}) VALUES (${columns.map((column) => `$${column}`).join(", ")})`,
      params,
    );
  }

  for (const detail of entry.details) {
    const record = entry.rows.find((candidate) => candidate.id === detail.fileId);
    db.run(
      "INSERT INTO file_details (file_id, version, size, mtime_ms, print, error) VALUES ($id, 1, $size, $mtime, $print, $error)",
      {
        $id: detail.fileId,
        $size: record?.size ?? 0,
        $mtime: record?.mtime_ms ?? 0,
        $print: detail.print === null ? null : Buffer.from(detail.print, "hex"),
        $error: detail.print === null ? "no print" : null,
      },
    );
  }

  for (const files of entry.dismissals) {
    addDismissal(db, { fileIds: files.map((id) => FileIdSchema.parse(id)), planId: null });
  }

  for (const [index, timing] of entry.timings.entries()) {
    db.run(
      "INSERT INTO encode_timings (id, encoder, pixels, media_ms, wall_ms, at) VALUES ($id, 'svt-av1', $pixels, $media, $wall, 0)",
      { $id: index + 1, $pixels: timing.pixels, $media: timing.mediaMs, $wall: timing.wallMs },
    );
  }

  return db;
}

const DEFAULT_SETTINGS: Settings = {
  preferredFolders: [],
  similarity: "balanced",
  spotVariants: false,
  reencodeQuality: "high",
  autoAnalyze: true,
};

/** A 64×64 detail print: soft gradients and blocks, different for each seed. */
function detailPrint(seed: number): Uint8Array {
  const next = random(seed);
  const print = new Uint8Array(64 * 64);

  const blocks = Array.from({ length: 6 }, () => ({
    x: Math.floor(next() * 56),
    y: Math.floor(next() * 56),
    size: 4 + Math.floor(next() * 12),
    value: Math.floor(next() * 255),
  }));

  for (let y = 0; y < 64; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      let value = 40 + ((x * 2 + y * (seed % 3)) % 160);

      for (const block of blocks) {
        if (x >= block.x && x < block.x + block.size && y >= block.y && y < block.y + block.size) {
          value = block.value;
        }
      }

      print[y * 64 + x] = value;
    }
  }

  return print;
}

/** A re-encode of a print: every value nudged a little, as a resize or recompression does. */
function copyOf(print: Uint8Array, seed: number): Uint8Array {
  const next = random(seed);

  return print.map((value) => Math.max(0, Math.min(255, value + Math.round((next() - 0.5) * 6))));
}

/** A variant of a print: one area changed, as another face or a caption does. */
function variantOf(print: Uint8Array, area: { x: number; y: number; value: number }): Uint8Array {
  const changed = Uint8Array.from(print);

  for (let y = area.y; y < area.y + 10; y += 1) {
    for (let x = area.x; x < area.x + 10; x += 1) {
      changed[y * 64 + x] = area.value;
    }
  }

  return changed;
}

const still = (base: string, bits: number, seed: number) =>
  `s:${flipBits(base, bits, random(seed))}`;

const PAGE = "a1b2c3d4e5f60718";

const OUTFIT = "0f1e2d3c4b5a6978";

const PAGE_PRINT = detailPrint(7);

const OUTFIT_PRINT = detailPrint(3);

const DUPLICATE_CATALOGS: SyntheticCatalog[] = [
  {
    name: "identical copies and a hard link",
    settings: DEFAULT_SETTINGS,
    rows: [
      row(1, "photos/sunset.png", {
        sha256: "aa",
        fingerprint: still(PAGE, 0, 1),
        mtime_ms: 1_600_000_000_000,
      }),
      row(2, "photos/sunset (1).png", { sha256: "aa", fingerprint: still(PAGE, 0, 1) }),
      row(3, "dup/sunset.png", { sha256: "aa", fingerprint: still(PAGE, 0, 1), ino: "1" }),
      row(4, "other/lonely.png", { sha256: "bb", fingerprint: still(OUTFIT, 0, 1) }),
      row(5, "other/lonely-link.png", { sha256: "bb", fingerprint: still(OUTFIT, 0, 1), ino: "4" }),
    ],
    details: [],
    dismissals: [],
    timings: [],
  },
  {
    name: "similar stills and videos",
    settings: DEFAULT_SETTINGS,
    rows: [
      row(1, "photos/forest.png", { fingerprint: still(OUTFIT, 0, 1), size: 400_000 }),
      row(2, "photos/forest-small.jpg", {
        format: "jpeg",
        fingerprint: still(OUTFIT, 5, 2),
        width: 320,
        height: 240,
        size: 40_000,
      }),
      row(3, "photos/forest.avif", {
        format: "avif",
        fingerprint: still(OUTFIT, 7, 3),
        size: 60_000,
      }),
      row(4, "photos/forest-crop.png", { fingerprint: still(OUTFIT, 11, 4), size: 380_000 }),
      row(5, "clips/talk.mp4", {
        kind: "video",
        format: "mp4",
        video_codec: "h264",
        audio_codec: "aac",
        audio_streams: 1,
        loudness_version: 1,
        loudness_max_db: -12,
        duration_ms: 60_000,
        width: 1280,
        height: 720,
        fingerprint:
          "m:60000:0123456789abcdef.0123456789abcdef.0123456789abcdef.0123456789abcdef.0123456789abcdef",
        size: 9_000_000,
      }),
      row(6, "clips/talk-silent.mp4", {
        kind: "video",
        format: "mp4",
        video_codec: "h264",
        audio_codec: "aac",
        audio_streams: 1,
        loudness_version: 1,
        loudness_max_db: -91,
        duration_ms: 60_400,
        width: 1920,
        height: 1080,
        fingerprint:
          "m:60400:0123456789abcdee.0123456789abcdef.0123456789abcdef.0123456789abcdef.0123456789abcdef",
        size: 12_000_000,
      }),
      row(7, "clips/talk.webm", {
        kind: "video",
        format: "webm",
        ext: "webm",
        video_codec: "vp9",
        audio_codec: "opus",
        audio_streams: 1,
        duration_ms: 60_100,
        width: 1280,
        height: 720,
        fingerprint:
          "m:60100:0123456789abcdef.0123456789abcdef.0123456789abcdef.0123456789abcdef.0123456789abcdef",
        size: 7_000_000,
      }),
      row(8, "clips/talk-copy.webm", {
        kind: "video",
        format: "webm",
        ext: "webm",
        video_codec: "vp9",
        audio_codec: "opus",
        audio_streams: 1,
        duration_ms: 60_100,
        width: 1280,
        height: 720,
        fingerprint:
          "m:60100:0123456789abcdef.0123456789abcdef.0123456789abcdef.0123456789abcdef.0123456789abcdef",
        size: 7_000_000,
        sha256: "cc",
      }),
      row(9, "clips/talk-copy-2.webm", {
        kind: "video",
        format: "webm",
        ext: "webm",
        video_codec: "vp9",
        audio_codec: "opus",
        audio_streams: 1,
        duration_ms: 60_100,
        width: 1280,
        height: 720,
        fingerprint:
          "m:60100:0123456789abcdef.0123456789abcdef.0123456789abcdef.0123456789abcdef.0123456789abcdef",
        size: 7_000_000,
        sha256: "cc",
      }),
      row(10, "photos/elsewhere.png", { root_id: 2, fingerprint: still(OUTFIT, 1, 5) }),
    ],
    details: [],
    dismissals: [],
    timings: [],
  },
  {
    name: "preferred folders and a dismissal",
    settings: {
      ...DEFAULT_SETTINGS,
      preferredFolders: [{ rootId: RootIdSchema.parse(1), dir: "keep" }],
    },
    rows: [
      row(1, "keep/inner/a.png", {
        fingerprint: still(PAGE, 0, 1),
        width: 320,
        height: 240,
        size: 10_000,
      }),
      row(2, "big/a.png", { fingerprint: still(PAGE, 3, 2), size: 900_000 }),
      row(3, "x/b.png", { fingerprint: still(OUTFIT, 0, 1) }),
      row(4, "y/b.png", { fingerprint: still(OUTFIT, 2, 2) }),
      row(5, "keeper/c.png", { sha256: "dd" }),
      row(6, "keep/c.png", { sha256: "dd" }),
    ],
    details: [],
    dismissals: [[3, 4]],
    timings: [],
  },
  {
    name: "spot variants",
    settings: { ...DEFAULT_SETTINGS, spotVariants: true },
    rows: [
      row(1, "fanbox/101_jp.png", { fingerprint: still(PAGE, 0, 1), size: 300_000 }),
      row(2, "fanbox/101_en.png", { fingerprint: still(PAGE, 2, 2), size: 301_000 }),
      row(3, "fanbox/101_clean.png", { fingerprint: still(PAGE, 3, 3), size: 299_000 }),
      row(4, "pixiv/900_p0.jpg", {
        format: "jpeg",
        fingerprint: still(PAGE, 4, 4),
        width: 480,
        height: 360,
        size: 80_000,
      }),
      row(5, "pixiv/900_p1.png", { fingerprint: still(PAGE, 2, 5), size: 500_000 }),
      row(6, "alt/outfit-a.png", { fingerprint: still(OUTFIT, 0, 1) }),
      row(7, "alt/outfit-b.png", { fingerprint: still(OUTFIT, 4, 2) }),
      row(8, "unprinted/one.png", { fingerprint: still("ffff0000ffff0000", 0, 1) }),
      row(9, "unprinted/two.png", { fingerprint: still("ffff0000ffff0000", 3, 2) }),
      row(10, "failed/one.png", { fingerprint: still("1234123412341234", 0, 1) }),
      row(11, "failed/two.png", { fingerprint: still("1234123412341234", 2, 2) }),
      row(12, "exact/one.png", { fingerprint: still("9999888877776666", 0, 1), sha256: "ee" }),
      row(13, "exact/two.png", { fingerprint: still("9999888877776666", 0, 1), sha256: "ee" }),
    ],
    details: [
      { fileId: 1, print: hex(PAGE_PRINT) },
      { fileId: 2, print: hex(variantOf(PAGE_PRINT, { x: 50, y: 4, value: 255 })) },
      { fileId: 3, print: hex(variantOf(PAGE_PRINT, { x: 8, y: 20, value: 10 })) },
      { fileId: 4, print: hex(copyOf(PAGE_PRINT, 4)) },
      { fileId: 5, print: hex(copyOf(variantOf(PAGE_PRINT, { x: 50, y: 4, value: 255 }), 5)) },
      { fileId: 6, print: hex(OUTFIT_PRINT) },
      { fileId: 7, print: hex(variantOf(OUTFIT_PRINT, { x: 8, y: 20, value: 10 })) },
      { fileId: 8, print: hex(detailPrint(11)) },
      { fileId: 10, print: null },
      { fileId: 11, print: hex(detailPrint(12)) },
    ],
    dismissals: [],
    timings: [],
  },
];

/** The clusters, the sets and every page of them for a catalog at a level. */
async function duplicateLevel(input: {
  db: CatalogDatabase;
  settings: Settings;
  rootId: RootId | null;
  level: SimilarityLevel;
}) {
  const { db, settings, rootId, level } = input;
  const clusters = await computeSimilarClusters(db, { rootId, level }, async () => undefined);
  const computed = buildDuplicateSets(db, { rootId, settings, clusters });
  const dismissals = Dismissals.load(db);
  // Pages name their sets by key; `computed` holds the sets themselves.

  const pages = (["all", "exact", "similar", "variants"] as const).flatMap((scope) =>
    [false, true].map((dismissed) => {
      const { sets, ...page } = pageDuplicateSets(computed, dismissals, {
        scope,
        dismissed,
        offset: 0,
        limit: 100,
      });

      return [
        `${scope}${dismissed ? "-dismissed" : ""}`,
        { ...page, sets: sets.map((set) => ({ key: set.key, dismissalId: set.dismissalId })) },
      ] as const;
    }),
  );

  return { clusters, computed, pages: Object.fromEntries(pages) };
}

describe("glazier-core duplicate set vectors", () => {
  it("builds sets, keepers and pictures as the committed vectors", async () => {
    const cases = [];

    for (const entry of DUPLICATE_CATALOGS) {
      const db = openCatalog(entry);

      try {
        const levels = [];

        for (const level of SimilarityLevelSchema.options) {
          // Every root as well as one, at the default level only, to keep the file small.
          const rootIds =
            level === "balanced" ? [null, RootIdSchema.parse(1)] : [RootIdSchema.parse(1)];

          for (const rootId of rootIds) {
            levels.push([
              `${level}:${rootId ?? "all"}`,
              await duplicateLevel({ db, settings: entry.settings, rootId, level }),
            ] as const);
          }
        }

        cases.push({ ...entry, levels: Object.fromEntries(levels) });
      } finally {
        db.close();
      }
    }

    expectCommitted("duplicate-sets.json", { about: about("duplicates/sets.ts"), cases });
  });
});

/* Convert's candidates and Shrink's estimate. */

const video = (codec: string, audio: string | null, overrides: CatalogRow = {}) =>
  ({
    kind: "video",
    format: "mp4",
    video_codec: codec,
    audio_codec: audio,
    audio_streams: audio === null ? 0 : 1,
    duration_ms: 30_000,
    width: 1280,
    height: 720,
    bitrate: 4_000_000,
    size: 15_000_000,
    fingerprint: `m:30000:${"0".repeat(16)}`,
    ...overrides,
  }) satisfies CatalogRow;

const OPTIMIZE_CATALOGS: SyntheticCatalog[] = [
  {
    name: "a mixed archive",
    settings: DEFAULT_SETTINGS,
    rows: [
      row(1, "stills/a.png", { fingerprint: still(PAGE, 0, 1) }),
      row(2, "stills/b.jpg", { format: "jpeg", fingerprint: still(OUTFIT, 0, 1) }),
      row(3, "stills/b.avif", { format: "avif", fingerprint: still("1111222233334444", 0, 1) }),
      row(4, "stills/cover.jpg", {
        format: "avif",
        ext_mismatch: 1,
        fingerprint: still("5555666677778888", 0, 1),
      }),
      row(5, "stills/loop.gif", {
        format: "gif",
        frames: 12,
        duration_ms: 1200,
        fingerprint: `m:1200:${"1".repeat(16)}`,
      }),
      row(6, "stills/still.gif", { format: "gif", fingerprint: still("aaaabbbbccccdddd", 0, 1) }),
      row(7, "stills/anim.webp", {
        format: "webp",
        frames: 3,
        fingerprint: `m:300:${"2".repeat(16)}`,
      }),
      row(8, "stills/scan.tif", {
        format: "tiff",
        ext: "tif",
        fingerprint: still("abababababababab", 0, 1),
      }),
      row(9, "stills/phone.heic", { format: "heic", probe_version: 0, fingerprint_version: 0 }),
      row(10, "stills/broken.png", {
        probe_error: "Input file has corrupt header",
        width: null,
        height: null,
      }),
      row(11, "stills/big.png", {
        optimize_not_smaller: 1,
        fingerprint: still("cdcdcdcdcdcdcdcd", 0, 1),
      }),
      row(12, "stills/new.png", { fingerprint_version: 0 }),
      row(13, "clips/a.mp4", video("h264", "aac")),
      row(14, "clips/b.m4v", video("h264", "aac", { ext: "m4v" })),
      row(15, "clips/c.mov", video("h264", "aac", { format: "mov" })),
      row(16, "clips/d.mkv", video("hevc", "opus", { format: "matroska" })),
      row(17, "clips/e.webm", video("vp9", "opus", { format: "webm" })),
      row(18, "clips/f.avi", video("mpeg4", "mp3", { format: "avi" })),
      row(19, "clips/g.mp4", video("mpeg4", null)),
      row(20, "clips/h.mp4", video("av1", "aac")),
      row(21, "clips/i.mp4", video("h264", "aac", { bitrate: 500_000 })),
      row(22, "clips/j.mp4", video("h264", "aac", { shrink_not_smaller: 1 })),
      row(23, "clips/k.mp4", video("h264", "aac", { bitrate: null })),
      row(
        24,
        "clips/l.mp4",
        video("h264", "pcm_s16le", {
          width: 3840,
          height: 2160,
          bitrate: 40_000_000,
          size: 150_000_000,
          duration_ms: 30_000,
        }),
      ),
      row(25, "clips/m.ts", video("h264", "ac3", { format: "mpegts", ext: "ts" })),
      row(26, "clips/n.mp4", video("h264", "aac", { sha256: "ff", bitrate: 9_000_000 })),
      row(27, "clips/n copy.mp4", video("h264", "aac", { sha256: "ff", bitrate: 9_000_000 })),
      row(28, "clips/o.mkv", video("h264", "aac", { format: "matroska" })),
      row(29, "clips/o.mp4", video("h264", "aac", { bitrate: 8_000_000, size: 30_000_000 })),
      row(30, "clips/p.flv", video("h264", "aac", { format: "flv" })),
      row(
        31,
        "clips/q.mp4",
        video("prores", null, { width: 640, height: 480, bitrate: 50_000_000 }),
      ),
      row(32, "clips/r.mp4", {
        kind: "video",
        format: "mp4",
        video_codec: null,
        audio_codec: "aac",
        audio_streams: 1,
      }),
      row(33, "misnamed.mp4", {
        format: "png",
        ext: "mp4",
        ext_mismatch: 1,
        kind: "image",
        fingerprint: still("0101010101010101", 0, 1),
      }),
      row(34, "junk.png", { is_junk: 1 }),
      row(35, "empty.png", { size: 0 }),
    ],
    details: [],
    dismissals: [],
    timings: [],
  },
  {
    name: "a measured machine, analysis off",
    settings: { ...DEFAULT_SETTINGS, autoAnalyze: false },
    rows: [
      row(1, "clips/a.mp4", video("h264", "aac", { width: 640, height: 480, bitrate: 2_000_000 })),
      row(
        2,
        "clips/b.mp4",
        video("h264", "aac", { width: 1920, height: 1080, bitrate: 6_000_000 }),
      ),
      row(
        3,
        "clips/c.mp4",
        video("h264", "aac", {
          width: 3840,
          height: 2160,
          bitrate: 30_000_000,
          fingerprint_version: 0,
        }),
      ),
      row(4, "stills/new.png", { fingerprint_version: 0 }),
    ],
    details: [],
    dismissals: [],
    timings: [
      { pixels: 640 * 480, mediaMs: 60_000, wallMs: 10_000 },
      { pixels: 640 * 480, mediaMs: 60_000, wallMs: 12_000 },
      { pixels: 640 * 480, mediaMs: 60_000, wallMs: 30_000 },
      { pixels: 640 * 480, mediaMs: 5_000, wallMs: 1 },
      { pixels: 1920 * 1080, mediaMs: 60_000, wallMs: 20_000 },
      { pixels: 1920 * 1080, mediaMs: 60_000, wallMs: 0 },
    ],
  },
];

const SPEED_PIXELS = [
  1,
  640 * 480,
  1_000_000,
  1_000_001,
  1920 * 1080,
  2_200_000,
  2_200_001,
  3840 * 2160,
];

describe("glazier-core Convert and Shrink vectors", () => {
  it("finds candidates and estimates as the committed vectors", () => {
    const cases = OPTIMIZE_CATALOGS.map((entry) => {
      const db = openCatalog(entry);
      const rootId = RootIdSchema.parse(1);

      try {
        const holds = {
          reviewing: new Set([FileIdSchema.parse(2)]),
          waitForFingerprints: entry.settings.autoAnalyze,
        };

        const convert = [NO_HOLDS, holds].map((candidateHolds) => {
          const scan = findOptimizeCandidates(db, rootId, candidateHolds);

          return {
            summary: summarizeCandidates(scan),
            candidates: scan.candidates.map((candidate) => ({
              id: candidate.record.id,
              category: candidate.category,
              targetName: candidate.targetName,
            })),
            extensionFixes: extensionFixes(db, rootId, scan.candidates).map((fix) => ({
              id: fix.record.id,
              name: fix.name,
            })),
          };
        });

        const shrink = [NO_HOLDS, holds].map((candidateHolds) => {
          const scan = findShrinkCandidates(db, rootId, candidateHolds);

          return {
            items: scan.candidates.map((candidate) => candidate.item),
            skipped: [...scan.skipped].map(([reason, files]) => ({ reason, files })),
            speedMeasured: scan.speedMeasured,
          };
        });

        const speed = encodeSpeed(db);

        return {
          ...entry,
          convert,
          shrink,
          speeds: SPEED_PIXELS.map((pixels) => ({ pixels, speed: speed.at(pixels) })),
        };
      } finally {
        db.close();
      }
    });

    expectCommitted("optimize.json", {
      about: about("optimize/candidates.ts, optimize/shrink.ts and optimize/encode-speed.ts"),
      cases,
    });
  });
});

/* ffprobe's JSON, as probeVideo reads it, through a stand-in ffprobe that prints it. */

const PROBES: Array<{ name: string; output: unknown }> = [
  {
    name: "H.264 with AAC",
    output: {
      streams: [
        {
          codec_type: "video",
          codec_name: "h264",
          width: 1920,
          height: 1080,
          duration: "12.345678",
        },
        { codec_type: "audio", codec_name: "aac", duration: "12.4" },
      ],
      format: { duration: "12.400000", bit_rate: "5123456" },
    },
  },
  {
    name: "rotated by side data",
    output: {
      streams: [
        {
          codec_type: "video",
          codec_name: "hevc",
          width: 1920,
          height: 1080,
          side_data_list: [{ side_data_type: "Display Matrix" }, { rotation: -90 }],
        },
      ],
      format: { duration: "3.000000" },
    },
  },
  {
    name: "rotated by tag",
    output: {
      streams: [
        {
          codec_type: "video",
          codec_name: "h264",
          width: 640,
          height: 480,
          tags: { rotate: "270" },
        },
      ],
      format: { duration: "N/A", bit_rate: "N/A" },
    },
  },
  {
    name: "half a turn",
    output: {
      streams: [
        {
          codec_type: "video",
          codec_name: "h264",
          width: 640,
          height: 480,
          tags: { rotate: "180" },
        },
      ],
      format: { duration: 2.5 },
    },
  },
  {
    name: "a cover picture then the video",
    output: {
      streams: [
        {
          codec_type: "video",
          codec_name: "mjpeg",
          width: 600,
          height: 600,
          disposition: { attached_pic: 1 },
        },
        {
          codec_type: "video",
          codec_name: "vp9",
          width: 1280,
          height: 720,
          disposition: { attached_pic: 0 },
        },
        { codec_type: "audio", codec_name: "opus" },
        { codec_type: "audio", codec_name: "aac" },
      ],
      format: { duration: "60.0005", bit_rate: 900000 },
    },
  },
  {
    name: "audio only",
    output: {
      streams: [{ codec_type: "audio", codec_name: "mp3" }],
      format: { duration: "180.5" },
    },
  },
  { name: "nothing", output: {} },
];

describe("glazier-core video probe vectors", () => {
  it("reads ffprobe's JSON as the committed vectors", async () => {
    const folder = mkdtempSync(path.join(scratch, "ffprobe-"));
    const cases = [];

    for (const [index, entry] of PROBES.entries()) {
      const json = path.join(folder, `${index}.json`);
      const tool = path.join(folder, `ffprobe-${index}`);
      writeFileSync(json, JSON.stringify(entry.output));
      writeFileSync(tool, `#!/bin/sh\nexec cat '${json}'\n`);
      chmodSync(tool, 0o755);
      cases.push({
        ...entry,
        stdout: JSON.stringify(entry.output),
        probe: await probeVideo(tool, "/any/file"),
      });
    }

    expectCommitted("video-probe.json", { about: about("media/video-probe.ts"), cases });
  });
});

/* The catalog's format: its schema, and a catalog glazier-core wrote for Rust to read. */

const MasterRowSchema = z.object({
  type: z.string(),
  name: z.string(),
  tbl_name: z.string(),
  sql: z.string().nullable(),
});

const CATALOG = path.join(VECTORS, "catalog.sqlite");

function walked(relPath: string, size: number): WalkedFile {
  const slash = relPath.lastIndexOf("/");
  const name = relPath.slice(slash + 1);

  return {
    relPath,
    dir: slash < 0 ? "" : relPath.slice(0, slash),
    name,
    ext: extensionOf(name),
    size,
    mtimeMs: 1_650_000_000_123,
    ctimeMs: 1_650_000_000_456,
    dev: "16777230",
    ino: String(1000 + size),
    junk: isSystemJunkFile(name),
  };
}

/** Writes the catalog Rust reads: a root, walked files with some passes' results, and settings. */
function makeCatalog(file: string): void {
  rmSync(file, { force: true });
  const db = new CatalogDatabase(file);
  db.run(
    "INSERT INTO roots (path, added_at, last_scan_at) VALUES ('/archive', 1650000000000, 1650000000999)",
  );
  const rootId = RootIdSchema.parse(1);
  upsertWalkedFiles(db, { rootId, scanId: 7 }, [
    walked("photos/sunset.png", 11_018),
    walked("photos/cover.jpg", 1358),
    walked("clips/talk.mov", 30_683),
    walked("notes.txt", 9),
    walked("._sunset.png", 4),
  ]);
  db.run(`UPDATE files SET format = 'png', probe_version = 1, width = 640, height = 480, frames = 1,
    has_alpha = 0, sha256 = 'abc', fingerprint_version = 1, fingerprint = 's:0123456789abcdef'
    WHERE rel_path = 'photos/sunset.png'`);
  db.run(`UPDATE files SET format = 'avif', kind = 'image', ext_mismatch = 1, probe_version = 1,
    width = 640, height = 480 WHERE rel_path = 'photos/cover.jpg'`);
  db.run(`UPDATE files SET format = 'mov', kind = 'video', probe_version = 1, width = 320,
    height = 240, duration_ms = 3000, video_codec = 'h264', audio_codec = 'aac', audio_streams = 1,
    bitrate = 81821.5, loudness_version = 1, loudness_max_db = -18.25 WHERE rel_path = 'clips/talk.mov'`);
  db.run("UPDATE files SET format = 'unknown' WHERE rel_path IN ('notes.txt', '._sunset.png')");
  db.run("INSERT INTO empty_folders (root_id, rel_path) VALUES (1, 'empty')");
  writeSettings(db, { ...DEFAULT_SETTINGS, spotVariants: true, similarity: "loose" });
  db.close();
}

function catalogContents(file: string) {
  const db = new CatalogDatabase(file);

  try {
    const rootId = RootIdSchema.parse(1);

    return {
      roots: listRoots(db),
      settings: readSettings(db),
      files: listFiles(db, {
        rootId,
        search: "",
        kinds: [],
        formats: [],
        audioStates: [],
        flags: [],
        dir: null,
        sort: "path",
        descending: false,
        offset: 0,
        limit: 100,
      }),
      tidy: catalogTidy(db, rootId),
    };
  } finally {
    db.close();
  }
}

describe("glazier-core catalog format vectors", () => {
  it("creates the committed schema at the committed user_version", () => {
    const file = path.join(scratch, "fresh.sqlite");
    new CatalogDatabase(file).close();
    const db = new DatabaseSync(file, { readOnly: true });

    try {
      const version = z
        .object({ user_version: z.number() })
        .parse(db.prepare("PRAGMA user_version").get());

      expectCommitted("catalog-schema.json", {
        about: about("catalog/database.ts, a catalog it creates"),
        userVersion: version.user_version,
        master: db
          .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
          .all()
          .map((entry) => MasterRowSchema.parse(entry)),
      });
    } finally {
      db.close();
    }
  });

  it("reads the committed catalog as the committed contents", () => {
    if (UPDATE) {
      makeCatalog(CATALOG);
    }

    // A copy is opened, so the committed file never gains a WAL or a newer header.
    const copy = path.join(scratch, "committed.sqlite");
    copyFileSync(CATALOG, copy);

    expectCommitted("catalog-contents.json", {
      about: about("catalog.sqlite, the catalog it wrote, as glazier-core reads it"),
      ...catalogContents(copy),
    });
  });
});
