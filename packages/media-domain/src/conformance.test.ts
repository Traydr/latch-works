/*
 * Conformance vectors for sort.ts. Oriel GPUI's Rust port (apps/oriel-gpui/crates/core-domain)
 * must produce the same, so the order of names cannot drift between the two apps (plan 063,
 * "Keeping two implementations honest").
 *
 * This suite checks that the TypeScript still makes the committed vectors, and
 * `cargo test -p oriel-core-domain` checks the Rust against the same file. After a deliberate
 * change to sort.ts, regenerate them and port the change:
 *
 *   ORIEL_GPUI_UPDATE_VECTORS=1 pnpm --filter @latch-works/media-domain test
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { GallerySortModeSchema } from "./media.js";
import { compareByName, hashString, type NamedPath, sortMediaItems } from "./sort.js";

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

/* ASCII-only JSON, which Biome then formats as the repository does. */
function writeVectors(vectors: SortVectors) {
  const json = JSON.stringify(vectors, null, 2).replace(
    /[\u007f-\uffff]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

  mkdirSync(dirname(vectorFile), { recursive: true });
  writeFileSync(vectorFile, `${json}\n`);
  execFileSync("pnpm", ["exec", "biome", "format", "--write", vectorFile], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
}

describe("media-domain sort conformance vectors", () => {
  const vectors = makeVectors();
  let committed: SortVectors;

  beforeAll(() => {
    if (updating) {
      writeVectors(vectors);
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
