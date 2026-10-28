/*
 * Conformance vectors for media-domain. Oriel GPUI's Rust port (apps/oriel-gpui/crates/core-domain)
 * must produce the same, so the order of names, the paths and the gallery's entries cannot drift
 * between the two apps (plan 063, "Keeping two implementations honest").
 *
 * This suite checks that the TypeScript still makes the committed vectors, one file per module in
 * apps/oriel-gpui/conformance/media-domain, and `cargo test -p oriel-core-domain` checks the Rust
 * against the same files. After a deliberate change to a module, regenerate them and port the
 * change:
 *
 *   ORIEL_GPUI_UPDATE_VECTORS=1 pnpm --filter @latch-works/media-domain test
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type BrowserEntry, buildBrowserEntries } from "./browser-entries.js";
import {
  type BuildComicEntriesOptions,
  buildComicEntries,
  type ComicEntry,
  type ComicMediaItem,
  sortComicEntries,
} from "./comics.js";
import {
  detectMediaType,
  FolderNodeSchema,
  GallerySortModeSchema,
  getExtension,
  ImageExtensions,
  isSupportedMediaFile,
  type MediaItem,
  MediaItemSchema,
  MediaTypeSchema,
  PdfExtensions,
  VideoExtensions,
} from "./media.js";
import {
  canonicalizeExtension,
  displayNameFromPath,
  formatBytes,
  getBaseName,
  getParentPath,
  joinArchivePath,
  normalizePathForCompare,
  pairSyncPaths,
  toArchivePath,
  trimTrailingSlash,
} from "./paths.js";
import { compareByName, hashString, type NamedPath, sortMediaItems } from "./sort.js";
import {
  GLAZIER_HOLDING_DIRECTORY_NAME,
  isSystemJunkDirectory,
  isSystemJunkFile,
  LATCH_WORKS_DIRECTORY_NAME,
} from "./system-files.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const vectorFile = fileURLToPath(
  new URL("../../../apps/oriel-gpui/conformance/media-domain/sort.json", import.meta.url),
);

const updating = process.env.ORIEL_GPUI_UPDATE_VECTORS === "1";

const NamedPathSchema = z.object({ name: z.string(), path: z.string() });

const SortVectorsSchema = z.object({
  about: z.string(),
  generatedWith: z.object({
    node: z.string(),
    icu: z.string(),
    unicode: z.string(),
    cldr: z.string(),
    collator: z.object({
      locale: z.string(),
      numeric: z.boolean(),
      sensitivity: z.string(),
      ignorePunctuation: z.boolean(),
      caseFirst: z.string(),
    }),
  }),
  naturalOrder: z.object({
    names: z.array(z.string()),
    classes: z.array(z.tuple([z.string()], z.string())),
  }),
  compareByName: z.array(
    z.object({
      a: NamedPathSchema,
      b: NamedPathSchema,
      order: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
    }),
  ),
  hashString: z.array(z.object({ value: z.string(), hash: z.number().int().nonnegative() })),
  sortMediaItems: z.object({
    items: z.array(
      z.object({ id: z.string(), name: z.string(), path: z.string(), mtimeMs: z.number() }),
    ),
    orders: z.array(
      z.object({ mode: GallerySortModeSchema, seed: z.number().int(), ids: z.array(z.string()) }),
    ),
  }),
});

type SortVectors = z.infer<typeof SortVectorsSchema>;

type Order = SortVectors["compareByName"][number]["order"];

const longRun = (digit: string, length: number) => digit.repeat(length);

/*
 * Names chosen to break a port of the natural order. Non-ASCII characters are escaped so that
 * combining marks, invisible characters and NFC against NFD stay visible in review.
 */
const naturalOrderNames = [
  // Digit runs: their value, leading zeros, and common prefixes that end inside a run.
  "0",
  "00",
  "000",
  "1",
  "01",
  "001",
  "2",
  "02",
  "9",
  "10",
  "010",
  "11",
  "19",
  "20",
  "99",
  "100",
  "101",
  "110",
  "1000",
  "a",
  "a0",
  "a1",
  "a01",
  "a001",
  "a1a",
  "a1b",
  "a01b",
  "a2",
  "a9",
  "a10",
  "a010",
  "a11",
  "a100",
  "a1000",
  "a10000",
  "a1b2",
  "a1b10",
  "a01b02",
  "a1.5",
  "a1.10",
  "a1.9",
  "a1,5",
  "file1.jpg",
  "file2.jpg",
  "file10.jpg",
  "file01.jpg",
  "file 1.jpg",
  "file 10.jpg",
  "file-1.jpg",
  "file_1.jpg",
  "file.1.jpg",
  "IMG_0001.JPG",
  "IMG_0002.JPG",
  "IMG_0010.JPG",
  "IMG_10.JPG",
  "img_2.jpg",
  "v1.2.9",
  "v1.2.10",
  "v1.10.0",
  "-1",
  "-2",
  "+1",
  "1 000",
  "1000 ",
  // Runs past 64 bits, and past the 254 digits ICU compares as one number.
  "18446744073709551615",
  "18446744073709551616",
  "18446744073709551617",
  "99999999999999999999",
  "100000000000000000000",
  "123456789012345678901234567890",
  "0000000000000000000000000000001",
  `x${longRun("9", 254)}`,
  `x${longRun("9", 254)}0`,
  `x1${longRun("0", 254)}`,
  `x${longRun("0", 260)}5`,
  `x${longRun("1", 300)}`,
  `x${longRun("1", 300)}2`,
  `x${longRun("1", 254)}2${longRun("1", 45)}`,
  // Decimal digits of other scripts, which are digits too, and digit-like characters that are not.
  "\uff11",
  "\uff12",
  "\uff11\uff10",
  "file\uff11\uff10",
  "file\uff112",
  "1\uff10",
  "\u0663",
  "\u0661\u0660",
  "\u096b",
  "\u0e51\u0e52",
  "\ud835\udfd7",
  "file\u00b2",
  "file2",
  "file\u2082",
  "\u2460",
  "\u216b",
  "\u00bd",
  // Case, width, ligatures and compatibility forms, which base strength ignores.
  "b",
  "B",
  "abc",
  "ABC",
  "Abc",
  "aBc",
  "Image.png",
  "image.png",
  "IMAGE.PNG",
  "\uff21",
  "\ud835\udc00",
  "\ufb01le",
  "file",
  "\u01c5",
  "dz",
  // Accents and other diacritics, precomposed and decomposed, and letters that are not accents.
  "cafe",
  "caf\u00e9",
  "cafe\u0301",
  "Caf\u00e9",
  "CAF\u00c9",
  "caf\u00e9s",
  "cafes",
  "resume",
  "r\u00e9sum\u00e9",
  "naive",
  "na\u00efve",
  "\u00c5ngstr\u00f6m",
  "Angstrom",
  "\u00c6sir",
  "Aesir",
  "stra\u00dfe",
  "strasse",
  "\u00d8resund",
  "Oresund",
  "\u0141\u00f3d\u017a",
  "Lodz",
  "\u00f0",
  "d",
  "\u0111",
  "\u00fe",
  "th",
  "\u0160iauliai",
  "Siauliai",
  "\u010desnakas",
  "cesnakas",
  "\u017euvis",
  "zuvis",
  "Ylakiai",
  "Ilakiai",
  "\u0105\u017euolas",
  "azuolas",
  "\u0131",
  "i",
  "\u0130",
  "I",
  "\u1ec7",
  "e\u0323\u0302",
  "e\u0302\u0323",
  "a\u0301\u0323",
  "a\u0323\u0301",
  "photo",
  "Photo",
  "PHOTO",
  "ph\u00f6to",
  // Other scripts, including Hangul syllables against their conjoining jamo.
  "\ud55c\uae00",
  "\u1112\u1161\u11ab\u1100\u1173\u11af",
  "\uac00",
  "\ub098",
  "\u03b1",
  "\u0391",
  "\u03ac",
  "\u03b2",
  "\u0436",
  "\u0416",
  "\u0451",
  "\u0435",
  "\u044f",
  "\u0561",
  "\u05e9\u05dc\u05d5\u05dd",
  "\u0633\u0644\u0627\u0645",
  "\u0928\u092e\u0938\u094d\u0924\u0947",
  "\u0e40\u0e01",
  "\u0e41\u0e01",
  "\u0e01\u0e32",
  "\u4e2d\u6587",
  "\u65e5\u672c",
  "\u6f22\u5b57",
  "\u6c49\u5b57",
  "\u4e00",
  "\u4e8c",
  "\u5341",
  "\u4e01",
  // Han outside the first block (Extension B, Extension A, a late addition, a radical, a
  // compatibility ideograph). Node's ICU orders all Han by radical and stroke; Chromium's ICU and
  // ICU4X order the blocks and then code points, so Electron Oriel and Rust differ from these.
  "\ud840\udc00",
  "\u3400",
  "\u9fff",
  "\u2f00",
  "\uf900",
  "\u3005",
  "\u3042",
  "\u30a2",
  "\uff71",
  "\u3041",
  "\u304b",
  "\u304c",
  "\u30ab",
  // Emoji: surrogate pairs, modifiers, joiners, flags and variation selectors.
  "\ud83d\ude00",
  "\ud83d\ude03",
  "\ud83d\udc4d",
  "\ud83d\udc4d\ud83c\udffd",
  "\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67",
  "\ud83c\uddf1\ud83c\uddf9",
  "\u2764\ufe0f",
  "\u2764",
  "photo \ud83d\ude00.jpg",
  "photo.jpg",
  // Punctuation, spaces and separators, which count at base strength.
  " ",
  "  ",
  "a b",
  "a  b",
  "a_b",
  "a-b",
  "a.b",
  "a,b",
  "ab",
  "a'b",
  "a\u2019b",
  "(a)",
  "[a]",
  "{a}",
  "#1",
  "#10",
  "@",
  "!",
  "~",
  "$",
  "\u20ac",
  "&",
  "a&b",
  "a+b",
  "_",
  "-",
  ".",
  "..",
  "...",
  ".hidden",
  "_hidden",
  "-hidden",
  "~$temp",
  "a\tb",
  "a\u00a0b",
  "a\u200bb",
  "a\u00adb",
  "a\u2010b",
  "a\u2013b",
  "a\u2014b",
  "a_1",
  "a-1",
  "a 1",
  "a.1",
  "/",
  "\\",
  "a/b",
  "a\\b",
  "a.jpg",
  "a.JPG",
  "a.jpeg",
  "a (1).jpg",
  "a (2).jpg",
  "a (10).jpg",
  "a copy.jpg",
  "a copy 2.jpg",
  // Empty and ignorable names, unassigned and private-use code points, and long names.
  "",
  "\u200b",
  "\u00ad",
  "\ufeff",
  "\u0000",
  "\u0301",
  "\ufe0f",
  "\u0378",
  "\ue000",
  "\udbff\udffd",
  "\ufffd",
  "\uffff",
  "a".repeat(300),
  `${"a".repeat(300)}1`,
  `${"a".repeat(300)}2`,
  `${"a".repeat(300)}10`,
];

/* Pairs whose names tie, so the path decides, and pairs where nothing does. */
const compareByNamePairs: [NamedPath, NamedPath][] = [
  [
    { name: "Image.png", path: "/b/Image.png" },
    { name: "image.png", path: "/a/image.png" },
  ],
  [
    { name: "photo.jpg", path: "/x/photo.jpg" },
    { name: "Photo.jpg", path: "/x/Photo.jpg" },
  ],
  [
    { name: "a.jpg", path: "/z/a.jpg" },
    { name: "b.jpg", path: "/a/b.jpg" },
  ],
  [
    { name: "x.jpg", path: "/a/2/x.jpg" },
    { name: "x.jpg", path: "/a/10/x.jpg" },
  ],
  [
    { name: "x.jpg", path: "/a b/x.jpg" },
    { name: "x.jpg", path: "/a/x.jpg" },
  ],
  [
    { name: "x.jpg", path: "/a-b/x.jpg" },
    { name: "x.jpg", path: "/a_b/x.jpg" },
  ],
  [
    { name: "x.jpg", path: "/a/x.jpg" },
    { name: "x.jpg", path: "/a.b/x.jpg" },
  ],
  [
    { name: "x.jpg", path: "C:\\a\\x.jpg" },
    { name: "x.jpg", path: "C:/a/x.jpg" },
  ],
  [
    { name: "caf\u00e9.jpg", path: "/p/caf\u00e9.jpg" },
    { name: "cafe\u0301.jpg", path: "/p/cafe\u0301.jpg" },
  ],
  [
    { name: "caf\u00e9.jpg", path: "/b/caf\u00e9.jpg" },
    { name: "cafe\u0301.jpg", path: "/a/cafe\u0301.jpg" },
  ],
  [
    { name: "", path: "/b" },
    { name: "", path: "/a" },
  ],
  [
    { name: "1.jpg", path: "/x/01.jpg" },
    { name: "01.jpg", path: "/x/1.jpg" },
  ],
  [
    { name: "\uff38.jpg", path: "/x/\uff38.jpg" },
    { name: "x.jpg", path: "/x/x.jpg" },
  ],
  [
    { name: "\ud83d\ude00.jpg", path: "/\ud83d\ude00/\ud83d\ude00.jpg" },
    { name: "\ud83d\ude00.jpg", path: "/\ud83d\ude03/\ud83d\ude00.jpg" },
  ],
];

const hashStringValues = [
  "",
  "a",
  "abc",
  "0:/archive/image-1.png",
  "42:C:\\archive\\image-1.png",
  "4294967295:/archive/image-1.png",
  "-1:/archive/image-1.png",
  "9007199254740991:/archive/image-1.png",
  "caf\u00e9",
  "cafe\u0301",
  "\u4e2d\u6587",
  "\ud83d\ude00",
  "\ud840\udc00",
  "\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67",
  "\ud83c\uddf1\ud83c\uddf9",
  "\u0000",
  "\ud7ff",
  "\ue000",
  "\uffff",
  "\udbff\udfff",
  "0123456789".repeat(100),
  "\u00e9\ud83d\ude00".repeat(200),
];

/*
 * Items for the gallery's modes: tied names and dates, an exact duplicate (m06 of m05), a shared
 * path so random scores tie (m20 to m23), fractional and far-future dates, Windows paths.
 */
const sortItems = [
  { id: "m01", name: "img10.jpg", path: "/archive/2024/img10.jpg", mtimeMs: 1_700_000_000_000 },
  { id: "m02", name: "img2.jpg", path: "/archive/2024/img2.jpg", mtimeMs: 1_700_000_000_000 },
  { id: "m03", name: "img02.jpg", path: "/archive/2024/img02.jpg", mtimeMs: 1_700_000_000_000.5 },
  { id: "m04", name: "Photo.jpg", path: "/archive/b/Photo.jpg", mtimeMs: 1_600_000_000_000 },
  { id: "m05", name: "photo.jpg", path: "/archive/a/photo.jpg", mtimeMs: 1_600_000_000_000 },
  { id: "m06", name: "photo.jpg", path: "/archive/a/photo.jpg", mtimeMs: 1_600_000_000_000 },
  { id: "m07", name: "PHOTO.JPG", path: "/archive/a/PHOTO.JPG", mtimeMs: 1_650_000_000_000.25 },
  { id: "m08", name: "caf\u00e9.jpg", path: "/archive/caf\u00e9.jpg", mtimeMs: 0 },
  { id: "m09", name: "cafe\u0301.jpg", path: "/archive/cafe\u0301.jpg", mtimeMs: 0 },
  { id: "m10", name: "cafe.jpg", path: "/archive/cafe.jpg", mtimeMs: 0 },
  {
    id: "m11",
    name: "IMG_0001.JPG",
    path: "C:\\archive\\IMG_0001.JPG",
    mtimeMs: 1_234_567_890_123.456,
  },
  {
    id: "m12",
    name: "IMG_0010.JPG",
    path: "C:\\archive\\IMG_0010.JPG",
    mtimeMs: 1_234_567_890_123.457,
  },
  {
    id: "m13",
    name: "IMG_10.JPG",
    path: "C:\\archive\\IMG_10.JPG",
    mtimeMs: 1_234_567_890_123.456,
  },
  {
    id: "m14",
    name: "\u4e2d\u6587.png",
    path: "/archive/\u4e2d\u6587.png",
    mtimeMs: 4_102_444_800_000,
  },
  {
    id: "m15",
    name: "\ud83d\ude00.gif",
    path: "/archive/\ud83d\ude00.gif",
    mtimeMs: 4_102_444_800_000,
  },
  { id: "m16", name: "a (1).jpg", path: "/archive/a (1).jpg", mtimeMs: 1_500_000_000_000 },
  { id: "m17", name: "a (10).jpg", path: "/archive/a (10).jpg", mtimeMs: 1_500_000_000_000 },
  { id: "m18", name: "a (2).jpg", path: "/archive/a (2).jpg", mtimeMs: 1_500_000_000_001 },
  { id: "m19", name: "a copy.jpg", path: "/archive/a copy.jpg", mtimeMs: 1_500_000_000_000 },
  { id: "m20", name: "image-1", path: "/same-path", mtimeMs: 0 },
  { id: "m21", name: "image-10", path: "/same-path", mtimeMs: 0 },
  { id: "m22", name: "Image-2", path: "/same-path", mtimeMs: 0 },
  { id: "m23", name: "image-2", path: "/same-path", mtimeMs: 0 },
  { id: "m24", name: "", path: "/archive/.hidden", mtimeMs: 1 },
  { id: "m25", name: "\u0160iauliai.jpg", path: "/archive/\u0160iauliai.jpg", mtimeMs: 2 },
  { id: "m26", name: "Siauliai.jpg", path: "/archive/Siauliai.jpg", mtimeMs: 2 },
  { id: "m27", name: "18446744073709551616.jpg", path: "/archive/2^64.jpg", mtimeMs: 3 },
  { id: "m28", name: "18446744073709551615.jpg", path: "/archive/2^64-1.jpg", mtimeMs: 3 },
  { id: "m29", name: "\uff11\uff10.jpg", path: "/archive/\uff11\uff10.jpg", mtimeMs: 3 },
  { id: "m30", name: "9.jpg", path: "/archive/9.jpg", mtimeMs: 3 },
];

/* Seeds as View's settings may hold them: createRandomSeed's u32 range, and any safe integer. */
const randomSeeds = [
  0,
  1,
  42,
  123_456_789,
  4_294_967_295,
  -1,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
];

function nameOnly(name: string): NamedPath {
  return { name, path: "" };
}

function orderOf(result: number): Order {
  if (result < 0) {
    return -1;
  }

  return result > 0 ? 1 : 0;
}

function naturalOrderClasses(names: readonly string[]): SortVectors["naturalOrder"]["classes"] {
  const classes: SortVectors["naturalOrder"]["classes"] = [];

  for (const entry of names.map(nameOnly).sort(compareByName)) {
    const current = classes.at(-1);

    if (current !== undefined && compareByName(nameOnly(current[0]), entry) === 0) {
      current.push(entry.name);
    } else {
      classes.push([entry.name]);
    }
  }

  return classes;
}

function makeVectors(): SortVectors {
  if (new Set(naturalOrderNames).size !== naturalOrderNames.length) {
    throw new Error("The natural order corpus repeats a name.");
  }

  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  }).resolvedOptions();

  return {
    about:
      "Made by packages/media-domain/src/conformance.test.ts from sort.ts; do not edit. Regenerate with ORIEL_GPUI_UPDATE_VECTORS=1 pnpm --filter @latch-works/media-domain test. Non-ASCII characters are escaped. naturalOrder.classes lists the names in order, names that compare equal sharing a class. Where Rust knowingly differs is listed in apps/oriel-gpui/crates/core-domain/tests/conformance.rs.",
    generatedWith: {
      node: process.versions.node,
      icu: process.versions.icu ?? "none",
      unicode: process.versions.unicode ?? "none",
      cldr: process.versions.cldr ?? "none",
      collator: {
        locale: collator.locale,
        numeric: collator.numeric,
        sensitivity: collator.sensitivity,
        ignorePunctuation: collator.ignorePunctuation,
        caseFirst: collator.caseFirst,
      },
    },
    naturalOrder: { names: naturalOrderNames, classes: naturalOrderClasses(naturalOrderNames) },
    compareByName: compareByNamePairs.flatMap(([a, b]) => [
      { a, b, order: orderOf(compareByName(a, b)) },
      { a: b, b: a, order: orderOf(compareByName(b, a)) },
    ]),
    hashString: hashStringValues.map((value) => ({ value, hash: hashString(value) })),
    sortMediaItems: {
      items: sortItems,
      orders: GallerySortModeSchema.options.flatMap((mode) =>
        (mode === "random" ? randomSeeds : [0]).map((seed) => ({
          mode,
          seed,
          ids: sortMediaItems(sortItems, mode, seed).map((item) => item.id),
        })),
      ),
    },
  };
}

/*
 * Writes JSON as ASCII, which Biome then formats as the repository does. sort.json is written
 * indented, which keeps its objects expanded; the other files are written compact, so Biome puts
 * each case that fits on one line.
 */
function writeVectors(file: string, json: string) {
  const ascii = json.replace(
    /[\u007f-\uffff]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${ascii}\n`);
  execFileSync("pnpm", ["exec", "biome", "format", "--write", file], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
}

describe("media-domain sort conformance vectors", () => {
  const vectors = makeVectors();
  let committed: SortVectors;

  beforeAll(() => {
    if (updating) {
      writeVectors(vectorFile, JSON.stringify(vectors, null, 2));
    }

    committed = SortVectorsSchema.parse(JSON.parse(readFileSync(vectorFile, "utf8")));
  });

  it("orders the names as the committed natural order", () => {
    expect(vectors.naturalOrder).toEqual(committed.naturalOrder);
  });

  it("orders every pair of names as their classes do", () => {
    const rankOf = new Map(
      committed.naturalOrder.classes.flatMap((names, rank) =>
        names.map((name) => [name, rank] as const),
      ),
    );

    const disagreements: string[] = [];

    for (const [a, aRank] of rankOf) {
      for (const [b, bRank] of rankOf) {
        const expected = orderOf(aRank - bRank);
        const actual = orderOf(compareByName(nameOnly(a), nameOnly(b)));

        if (actual !== expected) {
          disagreements.push(`${JSON.stringify(a)} against ${JSON.stringify(b)}: ${actual}`);
        }
      }
    }

    expect(rankOf.size).toBe(committed.naturalOrder.names.length);
    expect(disagreements).toEqual([]);
  });

  it("breaks name ties by path as the committed pairs do", () => {
    expect(vectors.compareByName).toEqual(committed.compareByName);
  });

  it("hashes strings as the committed hashes", () => {
    expect(vectors.hashString).toEqual(committed.hashString);
  });

  it("sorts media items in every mode as the committed orders", () => {
    expect(vectors.sortMediaItems).toEqual(committed.sortMediaItems);
  });
});

/*
 * The rest of media-domain: media kinds, archive paths, comics, the gallery's entries and the
 * system files scans skip. Each module has its own file beside sort.json.
 */

const vectorDirectory = dirname(vectorFile);

const RuntimeSchema = z.object({ node: z.string(), icu: z.string(), unicode: z.string() });

type Runtime = z.infer<typeof RuntimeSchema>;

/* Case mapping, NFC and collation follow the runtime's Unicode data, so each file says which. */
function runtimeVersions(): Runtime {
  return {
    node: process.versions.node,
    icu: process.versions.icu ?? "none",
    unicode: process.versions.unicode ?? "none",
  };
}

function aboutModule(source: string): string {
  return `Made by packages/media-domain/src/conformance.test.ts from ${source}; do not edit. Regenerate with ORIEL_GPUI_UPDATE_VECTORS=1 pnpm --filter @latch-works/media-domain test. Non-ASCII characters are escaped.`;
}

/* Rewrites the file first when updating, then parses what is committed. */
function committedVectors<T>(fileName: string, schema: z.ZodType<T>, vectors: T): T {
  const file = join(vectorDirectory, fileName);

  if (updating) {
    writeVectors(file, JSON.stringify(vectors));
  }

  return schema.parse(JSON.parse(readFileSync(file, "utf8")));
}

function requireUnique(corpus: readonly string[], what: string): readonly string[] {
  if (new Set(corpus).size !== corpus.length) {
    throw new Error(`The ${what} corpus repeats an entry.`);
  }

  return corpus;
}

/* media.ts */

const MediaVectorsSchema = z.object({
  about: z.string(),
  generatedWith: RuntimeSchema,
  imageExtensions: z.array(z.string()),
  videoExtensions: z.array(z.string()),
  pdfExtensions: z.array(z.string()),
  mediaTypes: z.array(MediaTypeSchema),
  gallerySortModes: z.array(GallerySortModeSchema),
  files: z.array(
    z.object({
      fileName: z.string(),
      extension: z.string(),
      mediaType: MediaTypeSchema,
      supported: z.boolean(),
    }),
  ),
});

type MediaVectors = z.infer<typeof MediaVectorsSchema>;

/* Each listed extension as written, in capitals, and capitalised. */
const listedExtensionNames = [...ImageExtensions, ...VideoExtensions, ...PdfExtensions].flatMap(
  (extension) => [
    `a.${extension}`,
    `A.${extension.toUpperCase()}`,
    `a.${extension.charAt(0).toUpperCase()}${extension.slice(1)}`,
  ],
);

const mediaFileNames = requireUnique(
  [
    ...listedExtensionNames,
    // Formats the gallery does not list, HEIC among them, though ImageIO could show it.
    "a.heic",
    "a.HEIC",
    "a.heif",
    "a.jxl",
    "a.tif",
    "a.tiff",
    "a.svg",
    "a.ico",
    "a.jfif",
    "a.jpe",
    "a.apng",
    "a.avi",
    "a.wmv",
    "a.flv",
    "a.ts",
    "a.mts",
    "a.m2ts",
    "a.3gp",
    "a.ogv",
    "a.mpg",
    "a.mpeg",
    "a.epub",
    "a.cbz",
    "a.zip",
    "a.txt",
    // Where the last dot is: nowhere, at the end, first (dotfiles), doubled, in a folder's name.
    "a",
    "a.",
    ".",
    "..",
    "...",
    ".jpg",
    ".GIF",
    ".jpeg",
    "..jpg",
    "a..jpg",
    "a.jpg.",
    "a.jpg.txt",
    "a.txt.jpg",
    "a.tar.gz",
    ".DS_Store",
    "dir/file.jpg",
    "dir.mp4/file",
    "dir.d/file",
    "C:\\Photos\\IMG_0001.JPG",
    "C:\\Videos.mp4\\file",
    "/archive/2024/clip.MOV",
    // Spaces and invisible characters beside the extension.
    "a.jpeg ",
    " a.jpg",
    "a. jpg",
    "a.jp g",
    "a.jpg\u200b",
    "a.webp\u0000",
    "a\u0000.webp",
    "a.jpg\t",
    // The Kelvin sign lowercases to k; full-width letters stay full width; a dotted capital I
    // lowercases to two characters; a capital sigma at the end takes its final form.
    "video.m\u212av",
    "video.M\u212aV",
    "a.\uff4a\uff50\uff47",
    "a.\uff2a\uff30\uff27",
    "a.G\u0130F",
    "a.\u03a3\u0391\u03a3",
    "caf\u00e9.jpg",
    "cafe\u0301.JPG",
    "\u5199\u771f.JPEG",
    "\ud83d\udcf7.webp",
    "\ud83d\udcf7",
    "a.\ud83d\udcf7",
    // Long names and long extensions.
    `${"a".repeat(255)}.jpg`,
    `${"\u00e9".repeat(200)}.MKV`,
    `a.${"x".repeat(300)}`,
    `${"a.".repeat(150)}gif`,
  ],
  "media file name",
);

function makeMediaVectors(): MediaVectors {
  return {
    about: aboutModule("media.ts"),
    generatedWith: runtimeVersions(),
    imageExtensions: [...ImageExtensions],
    videoExtensions: [...VideoExtensions],
    pdfExtensions: [...PdfExtensions],
    mediaTypes: [...MediaTypeSchema.options],
    gallerySortModes: [...GallerySortModeSchema.options],
    files: mediaFileNames.map((fileName) => ({
      fileName,
      extension: getExtension(fileName),
      mediaType: detectMediaType(fileName),
      supported: isSupportedMediaFile(fileName),
    })),
  };
}

describe("media-domain media conformance vectors", () => {
  const vectors = makeMediaVectors();
  let committed: MediaVectors;

  beforeAll(() => {
    committed = committedVectors("media.json", MediaVectorsSchema, vectors);
  });

  it("lists the committed extensions, media types and sort modes", () => {
    expect({ ...vectors, files: [] }).toEqual({ ...committed, files: [] });
  });

  it("reads extensions and media types of file names as committed", () => {
    expect(vectors.files).toEqual(committed.files);
  });
});

/* paths.ts */

const PathVectorsSchema = z.object({
  about: z.string(),
  generatedWith: RuntimeSchema,
  paths: z.array(
    z.object({
      path: z.string(),
      archivePath: z.string(),
      withoutTrailingSlash: z.string(),
      parentPath: z.string(),
      baseName: z.string(),
      displayName: z.string(),
      comparable: z.string(),
      comparableAsWritten: z.string(),
    }),
  ),
  extensions: z.array(z.object({ extension: z.string(), canonical: z.string() })),
  joins: z.array(z.object({ parts: z.array(z.string()), joined: z.string() })),
  pairs: z.array(
    z.object({
      about: z.string(),
      locals: z.array(z.string()),
      remotes: z.array(z.string()),
      pairs: z.array(z.tuple([z.string(), z.string()])),
    }),
  ),
  formatBytes: z.array(z.object({ bytes: z.number(), formatted: z.string() })),
});

type PathVectors = z.infer<typeof PathVectorsSchema>;

const pathCorpus = requireUnique(
  [
    // Empty paths, separators alone, and runs of them at either end and inside.
    "",
    "/",
    "//",
    "///a",
    "a",
    "a/",
    "a//",
    "a/b",
    "a//b",
    "a/b/",
    "/a/b",
    "//a//b//",
    "a/b//c///",
    // Windows separators, drive letters, UNC and extended-length paths, mixed separators.
    "\\",
    "\\\\",
    "a\\b",
    "a\\b\\",
    "\\a\\b",
    "a/b\\c",
    "a\\/b",
    "C:",
    "C:\\",
    "C:\\Photos",
    "C:\\Photos\\",
    "C:\\Photos\\IMG_0001.JPG",
    "C:\\Photos\\Sunset.JPEG",
    "c:/photos/img_0001.jpg",
    "\\\\server\\share\\a.jpg",
    "\\\\?\\C:\\very\\long\\path.jpeg",
    // Dot segments, which are kept as written.
    ".",
    "..",
    "./a",
    "../a/b",
    "a/./b",
    "a/../b",
    // The jpeg alias in a name, on a dotfile, before a trailing slash, doubled, on a folder.
    "jpeg",
    ".jpeg",
    "a.jpeg",
    "photos/sunset.jpeg",
    "photos/Sunset.JPEG",
    "photos/sunset.jpg",
    "photos/sunset.Jpeg",
    "photos/.jpeg",
    "photos/a.jpeg/",
    "photos/a.",
    "photos/a..jpeg",
    "photos.jpeg/a",
    "photos/a.jpeg.png",
    "photos/a.png.jpeg",
    "photos/a.JPEG\u200b",
    // Underscores and hyphens, which display names turn into spaces.
    "my_comic-title",
    "my_comic-title/",
    "comics/my_comic-title/001.jpg",
    "__init__",
    "--",
    "a - b",
    "a_b-c/d_e-f.jpg",
    // NFC against NFD, Hangul jamo, singleton decompositions (the ohm, angstrom and Kelvin
    // signs), final sigma before a dot, an apostrophe and a slash, dotted capital I, sharp s and
    // its capital, a titlecase digraph, full width, a Roman numeral, Deseret, Cherokee, Georgian.
    "caf\u00e9/Caf\u00e9.JPG",
    "cafe\u0301/Cafe\u0301.JPG",
    "\u1112\u1161\u11ab.jpeg",
    "\u2126.jpg",
    "\u212b.jpg",
    "\u212a.JPEG",
    "\u0391\u03a3.\u03a3\u0391\u03a3",
    "\u039f\u0394\u039f\u03a3/\u03a3\u03a3.jpg",
    "\u0391\u03a3'\u0392",
    "\u0391\u03a3/\u0392",
    "\u0130stanbul/I\u0130.JPG",
    "Stra\u00dfe.jpg",
    "\u1e9e.JPG",
    "\u01c5.jpg",
    "\u216b.jpg",
    "\uff21.JPG",
    "\ud801\udc00.JPEG",
    "\u13a0.jpg",
    "\u1c90.jpg",
    "\ud83d\udcf7/\ud83d\udcf7.JPEG",
    "\u5199\u771f/\u5199\u771f.JPEG",
    // Long paths and names.
    `${"a/".repeat(200)}b.JPEG`,
    `${"A".repeat(300)}.JPEG`,
    `${"\u00c9".repeat(150)}/x_y-z`,
  ],
  "path",
);

const extensionCorpus = requireUnique(
  [
    "jpeg",
    "JPEG",
    "Jpeg",
    ".jpeg",
    ".JPEG",
    "..jpeg",
    "jpeg.",
    " jpeg",
    "jpeg ",
    "jpg",
    "JPG",
    ".jpg",
    "",
    ".",
    "..",
    "png",
    ".PNG",
    "pNg",
    "tar.gz",
    ".tar.gz",
    "jpe",
    "jfif",
    "m\u212av",
    "\u0130",
    "\u03a3",
    "\u0391\u03a3",
    "JPEG\u0301",
    "\uff2a\uff30\uff25\uff27",
  ],
  "extension",
);

const joinCorpus: readonly (readonly string[])[] = [
  [],
  [""],
  ["a"],
  ["a", "b"],
  ["a/", "/b"],
  ["", "a", "", "b", ""],
  ["/"],
  ["/", "/"],
  ["C:\\x", "y"],
  ["a", "..", "b"],
  ["\\\\server", "share", "a.jpg"],
  ["a", " ", "b"],
  ["0", "0"],
  ["a\\", "\\b\\"],
  ["photos", "2024/", "/img.JPEG"],
];

interface PairScenario {
  about: string;
  locals: string[];
  remotes: string[];
}

/* How one file can be spelled on each side: a local path, and the remote it should pair with. */
type Spelling = (name: string) => [local: string, remote: string];

const spellings: [Spelling, ...Spelling[]] = [
  (name) => [name, name],
  (name) => [name.toUpperCase(), name],
  (name) => [`${name}.jpeg`, `${name}.jpg`],
  (name) => [`${name}.JPG`, `${name.toUpperCase()}.jpeg`],
  (name) => [`${name}e\u0301`, `${name}\u00e9`],
  (name) => [`\\${name}\\`, name],
];

/* Many paths in a scrambled order, so the order pairs are made in is pinned too. */
function scrambledPairScenario(): PairScenario {
  const locals: string[] = [];
  const remotes: string[] = [];

  for (let index = 0; index < 36; index += 1) {
    const spell = spellings[index % spellings.length] ?? spellings[0];
    const [local, remote] = spell(`f${(index * 7) % 36}/n${index}`);
    locals.push(local);
    remotes.unshift(remote);
  }

  locals.push("f0/n0", "orphan/local.jpg");
  remotes.push("orphan/remote.jpg");

  return { about: "many paths in a scrambled order", locals, remotes };
}

const pairScenarios: readonly PairScenario[] = [
  { about: "exact paths pair", locals: ["photos/a.jpg"], remotes: ["photos/a.jpg"] },
  {
    about: "jpeg aliases jpg when nothing collides",
    locals: ["photos/sunset.jpeg"],
    remotes: ["photos/sunset.jpg"],
  },
  {
    about: "jpg and jpeg on both sides stay apart",
    locals: ["photos/photo.jpg", "photos/photo.jpeg"],
    remotes: ["photos/photo.jpg", "photos/photo.jpeg"],
  },
  {
    about: "case twins pair with their exact spelling",
    locals: ["photos/Photo.jpg", "photos/photo.jpg"],
    remotes: ["photos/photo.jpg", "photos/Photo.jpg"],
  },
  {
    about: "a spelling several locals could claim pairs nothing",
    locals: ["photos/Photo.jpg", "photos/photo.jpg"],
    remotes: ["photos/PHOTO.JPG"],
  },
  {
    about: "a spelling several remotes could claim pairs nothing",
    locals: ["photos/PHOTO.JPG"],
    remotes: ["photos/Photo.jpg", "photos/photo.jpg"],
  },
  {
    about: "NFD pairs with NFC",
    locals: ["photos/cafe\u0301.jpg"],
    remotes: ["photos/caf\u00e9.jpg"],
  },
  {
    about: "Windows separators, a leading slash and a trailing slash pair as exact",
    locals: ["photos\\a.jpg", "/photos/b.jpg", "photos/c.jpg/"],
    remotes: ["photos/a.jpg", "photos/b.jpg", "photos/c.jpg"],
  },
  {
    about: "a local listed twice pairs nothing",
    locals: ["photos/a.jpg", "photos/a.jpg"],
    remotes: ["photos/a.jpg"],
  },
  {
    about: "a remote listed twice pairs nothing",
    locals: ["photos/a.jpg"],
    remotes: ["photos/a.jpg", "photos/a.jpg"],
  },
  {
    about: "a case match is taken before the alias",
    locals: ["photos/A.jpeg", "photos/a.jpg"],
    remotes: ["photos/a.jpeg"],
  },
  {
    about: "an alias collision leaves the alias unpaired",
    locals: ["x.jpeg", "x.JPG"],
    remotes: ["X.jpg"],
  },
  {
    about: "a remote paired exactly is not offered again",
    locals: ["a.jpg", "A.JPG"],
    remotes: ["a.jpg"],
  },
  { about: "no paths", locals: [], remotes: [] },
  { about: "only locals", locals: ["a.jpg"], remotes: [] },
  { about: "paths that are nothing once normalized", locals: ["/"], remotes: [""] },
  {
    about: "the alias on a folder is not folded",
    locals: ["photos.jpeg/a.jpg"],
    remotes: ["photos.jpg/a.jpg"],
  },
  { about: "dotfiles are not aliased", locals: ["photos/.jpeg"], remotes: ["photos/.jpg"] },
  {
    about: "a capital sigma before a dot is not final, so it does not fold to a final sigma",
    locals: ["\u039f\u0394\u039f\u03a3.jpg", "\u039f\u0394\u039f\u03a3/a.jpg"],
    remotes: ["\u03bf\u03b4\u03bf\u03c2.jpg", "\u03bf\u03b4\u03bf\u03c2/a.jpg"],
  },
  scrambledPairScenario(),
];

const kibibyte = 1024;

const byteCounts: readonly number[] = [
  // Bytes, and the ties toFixed rounds up where Rust's formatting rounds to even.
  0,
  1,
  2,
  2.5,
  3.5,
  51.2,
  512,
  1000,
  1023,
  1023.4,
  1023.5,
  1023.96,
  // Each unit's boundaries, its ties (1.25 and 1.75 of a unit) and values that round up to 1024.
  kibibyte,
  kibibyte + 1,
  1075,
  1075.2,
  1126.4,
  1280,
  1331.2,
  1536,
  1792,
  2304,
  10240,
  kibibyte ** 2 - 1,
  kibibyte ** 2,
  kibibyte ** 2 + 1,
  1.05 * kibibyte ** 2,
  1.25 * kibibyte ** 2,
  123_456_789,
  kibibyte ** 3 - 1,
  kibibyte ** 3,
  kibibyte ** 3 + 1,
  1.75 * kibibyte ** 3,
  5 * kibibyte ** 3,
  kibibyte ** 4 - 1,
  kibibyte ** 4,
  kibibyte ** 4 + 1,
  // Past TB the unit is missing from the table.
  kibibyte ** 5 - 2,
  kibibyte ** 5 - 1,
  kibibyte ** 5,
  kibibyte ** 6,
  2 ** 53,
  2 ** 53 + 2,
  2 ** 64,
  1e300,
  Number.MAX_VALUE,
  // Below one byte the unit is missing too, and negative counts are not a number.
  1 - Number.EPSILON / 2,
  0.5,
  0.001,
  1e-310,
  Number.MIN_VALUE,
  -1,
  -1024,
];

function makePathVectors(): PathVectors {
  return {
    about: aboutModule("paths.ts"),
    generatedWith: runtimeVersions(),
    paths: pathCorpus.map((path) => ({
      path,
      archivePath: toArchivePath(path),
      withoutTrailingSlash: trimTrailingSlash(path),
      parentPath: getParentPath(path),
      baseName: getBaseName(path),
      displayName: displayNameFromPath(path),
      comparable: normalizePathForCompare(path),
      comparableAsWritten: normalizePathForCompare(path, { canonicalizeExtensions: false }),
    })),
    extensions: extensionCorpus.map((extension) => ({
      extension,
      canonical: canonicalizeExtension(extension),
    })),
    joins: joinCorpus.map((parts) => ({ parts: [...parts], joined: joinArchivePath(...parts) })),
    pairs: pairScenarios.map((scenario) => ({
      ...scenario,
      pairs: [...pairSyncPaths(scenario.locals, scenario.remotes)],
    })),
    formatBytes: byteCounts.map((bytes) => ({ bytes, formatted: formatBytes(bytes) })),
  };
}

describe("media-domain paths conformance vectors", () => {
  const vectors = makePathVectors();
  let committed: PathVectors;

  beforeAll(() => {
    committed = committedVectors("paths.json", PathVectorsSchema, vectors);
  });

  it("normalizes, splits and compares paths as committed", () => {
    expect(vectors.paths).toEqual(committed.paths);
  });

  it("canonicalizes extensions and joins paths as committed", () => {
    expect(vectors.extensions).toEqual(committed.extensions);
    expect(vectors.joins).toEqual(committed.joins);
  });

  it("pairs local and remote paths, in the committed order", () => {
    expect(vectors.pairs).toEqual(committed.pairs);
  });

  it("formats byte counts as committed", () => {
    expect(vectors.formatBytes).toEqual(committed.formatBytes);
  });
});

/* comics.ts */

const ComicItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  mtimeMs: z.number(),
  mediaType: MediaTypeSchema,
});

type ComicItem = z.infer<typeof ComicItemSchema>;

const ComicSummarySchema = z.object({
  id: z.string(),
  folderPath: z.string(),
  name: z.string(),
  coverId: z.string(),
  pageIds: z.array(z.string()),
});

type ComicSummary = z.infer<typeof ComicSummarySchema>;

const ComicOrderSchema = z.object({
  mode: GallerySortModeSchema,
  seed: z.number().int(),
  ids: z.array(z.string()),
});

const ComicVectorsSchema = z.object({
  about: z.string(),
  generatedWith: RuntimeSchema,
  cases: z.array(
    z.object({
      about: z.string(),
      items: z.array(ComicItemSchema),
      rootPath: z.string().nullable(),
      leafFoldersOnly: z.boolean(),
      folders: z.array(z.object({ parentPath: z.string() })).nullable(),
      comics: z.array(ComicSummarySchema),
      orders: z.array(ComicOrderSchema),
    }),
  ),
});

type ComicVectors = z.infer<typeof ComicVectorsSchema>;

interface ComicScenario {
  about: string;
  items: ComicItem[];
  rootPath: string | null;
  leafFoldersOnly: boolean;
  folders: { parentPath: string }[] | null;
}

function page(id: string, path: string, mtimeMs = 0): ComicItem {
  return { id, name: getBaseName(path), path, mtimeMs, mediaType: "image" };
}

function comicScenario(
  about: string,
  items: ComicItem[],
  rootPath: string | null = "comics",
): ComicScenario {
  return { about, items, rootPath, leafFoldersOnly: false, folders: null };
}

const comicScenarios: readonly ComicScenario[] = [
  comicScenario("pages sort in natural order, then by path, and the first is the cover", [
    page("p10", "comics/vol-1/10.jpg"),
    page("p2", "comics/vol-1/2.jpg"),
    page("p01", "comics/vol-1/01.jpg"),
    page("p1", "comics/vol-1/1.jpg"),
    page("p1-capital", "comics/vol-1/1.JPG"),
    page("p1-copy", "comics/vol-1/1.jpg"),
    page("p1a", "comics/vol-1/1a.jpg"),
  ]),
  comicScenario("only images and GIFs are pages", [
    { ...page("video", "comics/a/0.mp4"), mediaType: "video" },
    { ...page("pdf", "comics/a/0.pdf"), mediaType: "pdf" },
    { ...page("unknown", "comics/a/0.txt"), mediaType: "unknown" },
    { ...page("gif", "comics/a/2.gif"), mediaType: "gif" },
    page("image", "comics/a/3.jpg"),
    { ...page("only-video", "comics/b/0.mp4"), mediaType: "video" },
  ]),
  comicScenario("files in the root, or in no folder, are not comics", [
    page("root", "comics/root.jpg"),
    page("top", "top.jpg"),
    page("slash", "/top.jpg"),
    page("backslash", "\\top.jpg"),
    page("kept", "comics/kept/1.jpg"),
  ]),
  comicScenario(
    "the root matches across case, NFC, separators and a trailing slash",
    [
      page("nfd", "comics/cafe\u0301/1.jpg"),
      page("windows", "comics\\cafe\u0301\\2.jpg"),
      page("leading", "/Comics/Caf\u00e9/3.jpg"),
      page("child", "comics/caf\u00e9/sub/4.jpg"),
    ],
    "Comics/Caf\u00e9/",
  ),
  comicScenario("no root excludes nothing", [page("a", "a/1.jpg"), page("b", "b/c/2.jpg")], null),
  comicScenario(
    "an empty root excludes nothing",
    [page("a", "a/1.jpg"), page("b", "b/c/2.jpg")],
    "",
  ),
  comicScenario(
    "a root of slashes excludes nothing",
    [page("a", "a/1.jpg"), page("b", "b/2.jpg")],
    "//",
  ),
  comicScenario("folders are keyed as written once separators fold, so case twins are two", [
    page("upper", "Series/A/1.jpg"),
    page("lower", "series/a/2.jpg"),
    page("windows", "series\\a\\3.jpg"),
    page("trailing", "series/a/4.jpg"),
  ]),
  comicScenario("display names turn underscores and hyphens into spaces", [
    page("title", "comics/my_comic-title/1.jpg"),
    page("dunder", "comics/__x__/1.jpg"),
    page("spaced", "comics/a - b/1.jpg"),
    page("dashes", "comics/--/1.jpg"),
  ]),
  comicScenario(
    "comics sort by name in natural order, then by path",
    [
      page("z", "z/Vol 10/1.jpg", 5),
      page("a", "a/Vol 2/1.jpg", 4),
      page("b", "b/vol 2/1.jpg", 4),
      page("top", "Vol 1/1.jpg", 3),
      page("c", "c/Vol 02/1.jpg", 2),
      page("d", "d/vol_2/1.jpg", 1),
    ],
    null,
  ),
  {
    about: "leaf folders only skips folders that hold folders, matching parent paths as written",
    items: [
      page("series-cover", "comics/series/cover.jpg"),
      page("chapter", "comics/series/ch-1/001.jpg"),
      page("other", "comics/other/x.jpg"),
      page("third", "comics/third/y.jpg"),
      page("leaf", "comics/leaf/z.jpg"),
    ],
    rootPath: "comics",
    leafFoldersOnly: true,
    folders: [
      { parentPath: "" },
      { parentPath: "comics" },
      { parentPath: "comics/series" },
      { parentPath: "comics\\other" },
      { parentPath: "/comics/third" },
    ],
  },
  {
    about: "leaf folders only without a folder list skips nothing",
    items: [page("cover", "comics/series/cover.jpg"), page("chapter", "comics/series/ch-1/1.jpg")],
    rootPath: "comics",
    leafFoldersOnly: true,
    folders: null,
  },
  {
    about: "a folder list without leaf folders only skips nothing",
    items: [page("cover", "comics/series/cover.jpg"), page("chapter", "comics/series/ch-1/1.jpg")],
    rootPath: "comics",
    leafFoldersOnly: false,
    folders: [{ parentPath: "comics/series" }],
  },
  comicScenario(
    "covers that share an id all map to the last comic with that id",
    [page("shared", "x/1.jpg", 1), page("shared", "y/1.jpg", 2), page("own", "z/1.jpg", 3)],
    null,
  ),
  comicScenario(
    "Unicode, Windows and long folder names",
    [
      page("kanji", "\u5199\u771f/\u7b2c1\u5dfb/001.jpg", 10),
      page("windows", "C:\\Comics\\Vol 1\\001.jpg", 20),
      page("emoji", "\ud83d\udcda/\ud83d\udcd6/1.jpg", 30),
      page("long", `${"\u00e9".repeat(120)}/${"x".repeat(200)}/1.jpg`, 40),
      page("nfc", "caf\u00e9/1.jpg", 50),
      page("nfd", "cafe\u0301/1.jpg", 50),
    ],
    null,
  ),
  comicScenario(
    "dates order the covers, and names break ties",
    [
      page("old", "b/1.jpg", 1_600_000_000_000),
      page("new", "a/1.jpg", 1_700_000_000_000.5),
      page("same-1", "d/1.jpg", 1_650_000_000_000),
      page("same-2", "c/1.jpg", 1_650_000_000_000),
      page("late-page", "c/2.jpg", 1_800_000_000_000),
    ],
    null,
  ),
];

const comicSeeds = [0, 42, 4_294_967_295, -1];

function summarizeComic(comic: ComicEntry<ComicItem>): ComicSummary {
  return {
    id: comic.id,
    folderPath: comic.folderPath,
    name: comic.name,
    coverId: comic.cover.id,
    pageIds: comic.pages.map((comicPage) => comicPage.id),
  };
}

function comicOptions(scenario: ComicScenario): BuildComicEntriesOptions {
  const options: BuildComicEntriesOptions = { leafFoldersOnly: scenario.leafFoldersOnly };

  if (scenario.folders !== null) {
    options.folders = scenario.folders;
  }

  return options;
}

function sortOrders<T extends ComicMediaItem>(
  comics: readonly ComicEntry<T>[],
): z.infer<typeof ComicOrderSchema>[] {
  return GallerySortModeSchema.options.flatMap((mode) =>
    (mode === "random" ? comicSeeds : [0]).map((seed) => ({
      mode,
      seed,
      ids: sortComicEntries(comics, mode, seed).map((comic) => comic.id),
    })),
  );
}

function makeComicVectors(): ComicVectors {
  return {
    about: aboutModule("comics.ts"),
    generatedWith: runtimeVersions(),
    cases: comicScenarios.map((scenario) => {
      const comics = buildComicEntries(scenario.items, scenario.rootPath, comicOptions(scenario));

      return { ...scenario, comics: comics.map(summarizeComic), orders: sortOrders(comics) };
    }),
  };
}

describe("media-domain comics conformance vectors", () => {
  const vectors = makeComicVectors();
  let committed: ComicVectors;

  beforeAll(() => {
    committed = committedVectors("comics.json", ComicVectorsSchema, vectors);
  });

  it("groups pages into comics as committed", () => {
    expect(vectors.cases.map(({ orders: _orders, ...rest }) => rest)).toEqual(
      committed.cases.map(({ orders: _orders, ...rest }) => rest),
    );
  });

  it("sorts comics in every mode as committed", () => {
    expect(vectors.cases.map((entry) => entry.orders)).toEqual(
      committed.cases.map((entry) => entry.orders),
    );
  });
});

/* browser-entries.ts */

const BrowserEntrySummarySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("folder"),
    key: z.string(),
    path: z.string(),
    name: z.string(),
    hasChildren: z.boolean(),
  }),
  z.object({ kind: z.literal("comic"), key: z.string(), comicId: z.string() }),
  z.object({
    kind: z.literal("media"),
    key: z.string(),
    mediaId: z.string(),
    mediaIndex: z.number().int(),
  }),
]);

type BrowserEntrySummary = z.infer<typeof BrowserEntrySummarySchema>;

const BrowserVectorsSchema = z.object({
  about: z.string(),
  generatedWith: RuntimeSchema,
  cases: z.array(
    z.object({
      about: z.string(),
      folders: z.array(FolderNodeSchema),
      items: z.array(MediaItemSchema),
      comics: z.array(ComicSummarySchema),
      views: z.array(
        z.object({
          recursive: z.boolean(),
          comicMode: z.boolean(),
          sortMode: GallerySortModeSchema,
          entries: z.array(BrowserEntrySummarySchema),
        }),
      ),
    }),
  ),
});

type BrowserVectors = z.infer<typeof BrowserVectorsSchema>;

type FolderNode = z.infer<typeof FolderNodeSchema>;

interface BrowserScenario {
  about: string;
  folders: FolderNode[];
  items: MediaItem[];
  rootPath: string;
  everyMode: boolean;
}

function folder(path: string, hasChildren = false): FolderNode {
  return { path, parentPath: getParentPath(path), name: getBaseName(path), hasChildren };
}

function mediaItem(
  id: string,
  path: string,
  mediaType: MediaItem["mediaType"] = "image",
): MediaItem {
  return {
    id,
    path,
    parentPath: getParentPath(path),
    name: getBaseName(path),
    extension: getExtension(path),
    mediaType,
    size: 1,
    mtimeMs: 0,
  };
}

const browserScenarios: readonly BrowserScenario[] = [
  {
    about: "folders sort by name alone and only name-desc reverses them, ties included",
    folders: [
      folder("root/Folder 10", true),
      folder("root/folder 2"),
      folder("root/Folder 2", true),
      folder("root/Folder 1"),
      { ...folder("root/a"), parentId: null },
      { ...folder("root/B"), parentId: "6f1c3c1e-8a2b-4c3d-9e4f-5a6b7c8d9e0f" },
      folder("root/\u00e9"),
      folder("root/e"),
      { path: "root/", parentPath: "root", name: "", hasChildren: false },
    ],
    items: [
      mediaItem("loose-2", "root/2.jpg"),
      mediaItem("loose-10", "root/10.mp4", "video"),
      mediaItem("page-b", "root/comic/b.jpg"),
      mediaItem("page-a", "root/comic/a.jpg"),
      mediaItem("other", "root/other/1.gif", "gif"),
    ],
    rootPath: "root",
    everyMode: true,
  },
  {
    about: "nothing to show",
    folders: [],
    items: [],
    rootPath: "root",
    everyMode: false,
  },
  {
    about: "media keep their index among all items, and keys use ids as written",
    folders: [folder("x/y:z")],
    items: [
      mediaItem("same", "x/1.jpg"),
      mediaItem("same", "x/2.jpg"),
      mediaItem("media:nested", "x/3.jpg"),
      mediaItem("\u5199\u771f", "x/4.jpg"),
      mediaItem("", "x/5.jpg"),
    ],
    rootPath: "x",
    everyMode: false,
  },
];

function summarizeEntry(entry: BrowserEntry): BrowserEntrySummary {
  switch (entry.kind) {
    case "folder":
      return {
        kind: "folder",
        key: entry.key,
        path: entry.path,
        name: entry.name,
        hasChildren: entry.hasChildren,
      };
    case "comic":
      return { kind: "comic", key: entry.key, comicId: entry.comic.id };
    case "media":
      return {
        kind: "media",
        key: entry.key,
        mediaId: entry.media.id,
        mediaIndex: entry.mediaIndex,
      };
    default: {
      const _exhaustive: never = entry;

      return _exhaustive;
    }
  }
}

function makeBrowserVectors(): BrowserVectors {
  return {
    about: aboutModule("browser-entries.ts"),
    generatedWith: runtimeVersions(),
    cases: browserScenarios.map((scenario) => {
      const comics = buildComicEntries(scenario.items, scenario.rootPath);

      const modes = scenario.everyMode
        ? GallerySortModeSchema.options
        : (["name-asc", "name-desc"] as const);

      return {
        about: scenario.about,
        folders: scenario.folders,
        items: scenario.items,
        comics: comics.map(summarizeComic),
        views: [false, true].flatMap((recursive) =>
          [false, true].flatMap((comicMode) =>
            modes.map((sortMode) => ({
              recursive,
              comicMode,
              sortMode,
              entries: buildBrowserEntries({
                folders: scenario.folders,
                comics,
                items: scenario.items,
                recursive,
                comicMode,
                sortMode,
              }).map(summarizeEntry),
            })),
          ),
        ),
      };
    }),
  };
}

describe("media-domain browser entries conformance vectors", () => {
  const vectors = makeBrowserVectors();
  let committed: BrowserVectors;

  beforeAll(() => {
    committed = committedVectors("browser-entries.json", BrowserVectorsSchema, vectors);
  });

  it("builds the gallery's entries in every view as committed", () => {
    expect(vectors.cases).toEqual(committed.cases);
  });
});

/* system-files.ts */

const SystemFileVectorsSchema = z.object({
  about: z.string(),
  generatedWith: RuntimeSchema,
  latchWorksDirectoryName: z.string(),
  glazierHoldingDirectoryName: z.string(),
  names: z.array(z.object({ name: z.string(), junkFile: z.boolean(), junkDirectory: z.boolean() })),
});

type SystemFileVectors = z.infer<typeof SystemFileVectorsSchema>;

const systemNameCorpus = requireUnique(
  [
    ".DS_Store",
    ".ds_store",
    ".DS_STORE",
    "DS_Store",
    ".DS_Store ",
    " .DS_Store",
    ".DS_Store.jpg",
    "desktop.ini",
    "Desktop.ini",
    "DESKTOP.INI",
    "desktop.ini.bak",
    "DESKTOP.\u0130N\u0130",
    "desktop.\u0131n\u0131",
    "ehthumbs.db",
    "EHTHUMBS.DB",
    "ehthumbs_vista.db",
    "Ehthumbs_Vista.db",
    "thumbs.db",
    "Thumbs.db",
    "THUMBS.DB",
    "Thumbs.db:encryptable",
    "thumbs.db ",
    "\uff34humbs.db",
    "Thumbs",
    // AppleDouble files, which start with "._" exactly.
    "._",
    "._photo.jpg",
    "._.DS_Store",
    ".__x",
    "._PHOTO",
    "_.photo",
    ". _photo",
    ".\uff3fphoto",
    // Folders.
    ".latch-works",
    ".Latch-Works",
    ".LATCH-WORKS",
    "latch-works",
    ".latch-works/",
    ".glazier-holding",
    ".Glazier-Holding",
    "$RECYCLE.BIN",
    "$Recycle.Bin",
    "$recycle.bin",
    "RECYCLE.BIN",
    "$RECYCLER",
    ".DocumentRevisions-V100",
    ".documentrevisions-v100",
    ".fseventsd",
    ".Spotlight-V100",
    ".spotlight-v100",
    ".TemporaryItems",
    ".Trashes",
    ".Trash",
    "__MACOSX",
    "__macosx",
    "_MACOSX",
    "System Volume Information",
    "system volume information",
    "SYSTEM VOLUME INFORMATION",
    "System Volume Information ",
    "System  Volume Information",
    "System\u00a0Volume\u00a0Information",
    "",
    ".",
    "..",
    "photo.jpg",
  ],
  "system file name",
);

function makeSystemFileVectors(): SystemFileVectors {
  return {
    about: aboutModule("system-files.ts"),
    generatedWith: runtimeVersions(),
    latchWorksDirectoryName: LATCH_WORKS_DIRECTORY_NAME,
    glazierHoldingDirectoryName: GLAZIER_HOLDING_DIRECTORY_NAME,
    names: systemNameCorpus.map((name) => ({
      name,
      junkFile: isSystemJunkFile(name),
      junkDirectory: isSystemJunkDirectory(name),
    })),
  };
}

describe("media-domain system files conformance vectors", () => {
  const vectors = makeSystemFileVectors();
  let committed: SystemFileVectors;

  beforeAll(() => {
    committed = committedVectors("system-files.json", SystemFileVectorsSchema, vectors);
  });

  it("recognizes the committed junk files and folders", () => {
    expect(vectors).toEqual(committed);
  });
});
