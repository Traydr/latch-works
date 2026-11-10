/*
 * Conformance vectors for media-format's file names and AVIF settings. Oriel's Rust port
 * (apps/oriel/crates/core-format) reads them, one file per module in
 * apps/oriel/conformance/media-format. This suite checks that the TypeScript still makes them;
 * after a deliberate change, regenerate them and port the change:
 *
 *   ORIEL_UPDATE_VECTORS=1 pnpm --filter @latch-works/media-format test
 */
import { expectCommitted as expectCommittedFile } from "@latch-works/conformance";
import { describe, expect, it } from "vitest";
import {
  ARCHIVE_AVIF_LOW_MEMORY_SPEED,
  ARCHIVE_AVIF_OPTIONS,
  ARCHIVE_AVIF_QUALITY,
  ARCHIVE_AVIF_SPEED,
  type AvifCodec,
  type AvifEncodeOptions,
  createArchiveAvifEncoder,
} from "./avif.js";
import { getFileExtension, replaceFileExtension } from "./file-names.js";
import { getExpectedArchiveTarget, planArchiveMedia } from "./still-policy.js";

function aboutModule(source: string): string {
  return `Made by packages/media-format/src/conformance.test.ts from ${source}; do not edit. Regenerate with ORIEL_UPDATE_VECTORS=1 pnpm --filter @latch-works/media-format test. Non-ASCII characters are escaped.`;
}

function expectCommitted<T extends object>(name: string, vectors: T): void {
  expectCommittedFile({ set: "media-format", name }, vectors);
}

function requireUnique<T>(corpus: readonly T[], what: string): readonly T[] {
  if (new Set(corpus.map((entry) => JSON.stringify(entry))).size !== corpus.length) {
    throw new Error(`The ${what} corpus repeats an entry.`);
  }

  return corpus;
}

/*
 * File names and paths as the policies receive them: from a download, a scan on macOS or a scan
 * on Windows. Non-ASCII characters are escaped so that combining marks stay visible in review.
 */
const fileNames = requireUnique(
  [
    // Every extension the policies name, in each case.
    "photo.jpg",
    "photo.JPG",
    "photo.jpeg",
    "photo.JPEG",
    "photo.Jpeg",
    "photo.png",
    "photo.PNG",
    "photo.webp",
    "photo.bmp",
    "photo.BMP",
    "photo.gif",
    "photo.GIF",
    "photo.avif",
    "photo.AVIF",
    "clip.mp4",
    "clip.MP4",
    "clip.Mp4",
    // Extensions they do not name.
    "photo.heic",
    "photo.tiff",
    "photo.svg",
    "photo.jfif",
    "photo.jpe",
    "clip.m4v",
    "clip.mov",
    "clip.mkv",
    "clip.webm",
    "story.pdf",
    "archive.zip",
    // No extension, a trailing dot, dotfiles, several dots, a dot only in a folder's name.
    "photo",
    "photo.",
    "photo..",
    ".jpg",
    ".avif",
    ".hidden.jpg",
    "..jpg",
    "a.b.c.png",
    "photo.jpg.mp4",
    "archive.tar.gz",
    "photo.jpg.",
    "dir.d/photo",
    "dir.d\\photo",
    "dir.avif/photo",
    "dir/.jpg",
    "dir\\.jpg",
    "photos/2024/",
    "photo.jpg/",
    "photo.jpg\\",
    // POSIX and Windows paths.
    "/archive/2024/photo.png",
    "C:\\Photos\\IMG_0001.JPG",
    "C:\\Photos.d\\IMG_0001",
    "\\\\server\\share\\clip.MOV",
    "a/b\\c.gif",
    // Spaces and invisible characters beside the dot.
    "photo .jpg",
    "photo.jpg ",
    "photo. jpg",
    " photo.png",
    "photo.jpg\u0000",
    "photo.jpg\u200b",
    // Unicode names and extensions: NFC and NFD, CJK, emoji, full width, a dotted capital I,
    // a capital sigma at the end of the extension, and the Kelvin sign.
    "caf\u00e9.png",
    "cafe\u0301.PNG",
    "\u5199\u771f.JPG",
    "\ud83d\udcf7.webp",
    "photo.\uff2a\uff30\uff27",
    "photo.G\u0130F",
    "photo.\u03a3\u0391\u03a3",
    "clip.M\u212aV",
    // Long names and extensions.
    `${"a".repeat(255)}.png`,
    `${"\u00e9".repeat(200)}.GIF`,
    `photo.${"x".repeat(300)}`,
    `${"a.".repeat(150)}jpeg`,
  ],
  "file name",
);

/* file-names.ts */

const replacementExtensions = ["avif", "mp4", "", ".x", "a.b", "AVIF"];

describe("media-format file names conformance vectors", () => {
  it("reads and swaps extensions as committed", () => {
    expectCommitted("file-names.json", {
      about: aboutModule("file-names.ts"),
      names: fileNames.map((fileName) => ({
        fileName,
        extension: getFileExtension(fileName),
        replaced: replacementExtensions.map((extension) =>
          replaceFileExtension(fileName, extension),
        ),
      })),
      replacementExtensions,
    });
  });
});

/* still-policy.ts */

/*
 * MIME types as servers send them: in capitals, with parameters, with whitespace JavaScript trims
 * (including U+FEFF) and characters it does not (U+0085, U+200B), and types that are not images.
 */
const mimeTypes = requireUnique(
  [
    "image/avif",
    "IMAGE/AVIF",
    "image/avif; charset=binary",
    " image/avif ",
    "\timage/avif\n",
    "\ufeffimage/avif",
    "image/avif\u0085",
    "image/avif\u00a0",
    "image/avif\u3000",
    "image/avif\u200b",
    "image/avif\u180e",
    "image/avif\u2028",
    "video/mp4",
    "VIDEO/MP4",
    "video/mp4;codecs=avc1",
    "video/mp4 ;",
    "image/gif",
    "image/GIF",
    "image/gif;",
    "video/webm",
    "video/quicktime",
    "video/",
    "video",
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/bmp",
    "image/heic",
    "image/jxl",
    "image/svg+xml",
    "IMAGE/SVG+XML",
    "image/svg+xml; charset=utf-8",
    "image/svg",
    "image/",
    "image",
    "images/png",
    "image /png",
    "image/avif, image/webp",
    "\u0130MAGE/PNG",
    "application/octet-stream",
    "application/pdf",
    "audio/mpeg",
    "text/html",
    "",
    " ",
    ";",
  ],
  "MIME type",
);

const mimeSweepNames = ["photo.jpg", "photo.avif", "clip.mp4", "photo"];

/* One MIME type per outcome; the sweep above covers the rest. */
const nameSweepMimeTypes = [
  "application/octet-stream",
  "image/png",
  "image/avif",
  "video/mp4",
  "image/gif",
];

function mediaCases() {
  const pairs = [
    ...mimeTypes.flatMap((mimeType) => mimeSweepNames.map((fileName) => ({ fileName, mimeType }))),
    ...fileNames.flatMap((fileName) =>
      nameSweepMimeTypes.map((mimeType) => ({ fileName, mimeType })),
    ),
  ];

  const seen = new Set<string>();

  return pairs.flatMap(({ fileName, mimeType }) => {
    const key = JSON.stringify([fileName, mimeType]);

    if (seen.has(key)) {
      return [];
    }

    seen.add(key);

    return [{ fileName, mimeType, plan: planArchiveMedia(fileName, mimeType) }];
  });
}

/* Gather Box alone runs the download policy, so its outcomes are a snapshot, not a vector. */
describe("media-format still policy", () => {
  it("plans downloads as the snapshot", () => {
    expect({
      expectedTargets: fileNames.map((fileName) => ({
        fileName,
        target: getExpectedArchiveTarget(fileName),
      })),
      media: mediaCases(),
    }).toMatchSnapshot();
  });
});

/* avif.ts */

type AttemptResult = "encodes" | "returns-nothing" | "throws";

const attemptScripts: readonly (readonly AttemptResult[])[] = [
  ["encodes"],
  ["returns-nothing", "encodes"],
  ["throws", "encodes"],
  ["returns-nothing", "returns-nothing"],
  ["throws", "throws"],
  ["returns-nothing", "throws"],
];

function scriptedCodec(script: readonly AttemptResult[], calls: AvifEncodeOptions[]): AvifCodec {
  return {
    encode(_data, _width, _height, options) {
      calls.push({ ...options });
      const result = script[calls.length - 1] ?? "encodes";

      switch (result) {
        case "encodes":
          return new Uint8Array([1, 2, 3]);
        case "returns-nothing":
          return null;
        case "throws":
          throw new RangeError("memory access out of bounds");
        default: {
          const _exhaustive: never = result;

          return _exhaustive;
        }
      }
    },
  };
}

async function runAttempts(script: readonly AttemptResult[]) {
  const calls: AvifEncodeOptions[] = [];
  const encode = createArchiveAvifEncoder(async () => scriptedCodec(script, calls));

  try {
    const encoded = await encode({ data: new Uint8Array(4), width: 1, height: 1 });

    return { script, calls, outcome: { kind: "encoded", bytes: encoded.byteLength } };
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    return { script, calls, outcome: { kind: "failed", name: error.name, message: error.message } };
  }
}

describe("media-format AVIF conformance vectors", () => {
  it("encodes stills with the committed settings and fallback", async () => {
    expectCommitted("avif.json", {
      about: aboutModule("avif.ts"),
      quality: ARCHIVE_AVIF_QUALITY,
      speed: ARCHIVE_AVIF_SPEED,
      lowMemorySpeed: ARCHIVE_AVIF_LOW_MEMORY_SPEED,
      options: ARCHIVE_AVIF_OPTIONS,
      attempts: await Promise.all(attemptScripts.map(runAttempts)),
    });
  });
});
