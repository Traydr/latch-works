/*
 * Conformance vectors for media-format's policies: which file becomes what, with which settings.
 * Oriel GPUI's Rust port (apps/oriel-gpui/crates/core-format) must decide the same, so the two
 * apps convert an archive alike (plan 063, "Keeping two implementations honest").
 *
 * This suite checks that the TypeScript still makes the committed vectors, one file per module in
 * apps/oriel-gpui/conformance/media-format, and `cargo test -p oriel-core-format` checks the Rust
 * against the same files. After a deliberate change to a policy, regenerate them and port the
 * change:
 *
 *   ORIEL_GPUI_UPDATE_VECTORS=1 pnpm --filter @latch-works/media-format test
 *
 * The committed files are only compared with what the TypeScript makes, never read for their
 * values, so they are not parsed into types here (this package has no schema library).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AUDIO_CODECS, VIDEO_CODECS } from "mediabunny";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ANIMATION_MP4_SETTINGS,
  type AnimatedImageMimeType,
  encodeAnimationAsMp4,
  type Mp4Encoder,
} from "./animation-mp4.js";
import {
  ARCHIVE_AVIF_LOW_MEMORY_SPEED,
  ARCHIVE_AVIF_OPTIONS,
  ARCHIVE_AVIF_QUALITY,
  ARCHIVE_AVIF_SHARP_OPTIONS,
  ARCHIVE_AVIF_SPEED,
  ARCHIVE_AVIF_WASM_PIXEL_LIMIT,
  type AvifCodec,
  type AvifEncodeOptions,
  createArchiveAvifEncoder,
} from "./avif.js";
import { getFileExtension, replaceFileExtension } from "./file-names.js";
import {
  type ArchiveImageFormat,
  getExpectedArchiveTarget,
  planArchiveImage,
  planArchiveMedia,
} from "./still-policy.js";
import {
  ARCHIVE_AUDIO_CODECS,
  ARCHIVE_DEFAULT_VIDEO_CODEC,
  ARCHIVE_VIDEO_CODECS,
  type ArchiveVideoSource,
  isArchiveVideoCodec,
  planArchiveVideo,
  planStripAudio,
  planVideoReencode,
  VIDEO_CONTAINERS,
} from "./video-policy.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const vectorDirectory = fileURLToPath(
  new URL("../../../apps/oriel-gpui/conformance/media-format/", import.meta.url),
);

const updating = process.env.ORIEL_GPUI_UPDATE_VECTORS === "1";

function aboutModule(source: string): string {
  return `Made by packages/media-format/src/conformance.test.ts from ${source}; do not edit. Regenerate with ORIEL_GPUI_UPDATE_VECTORS=1 pnpm --filter @latch-works/media-format test. Non-ASCII characters are escaped.`;
}

/* Compact ASCII-only JSON, which Biome then formats as the repository does. */
function writeVectors<T>(file: string, vectors: T) {
  const json = JSON.stringify(vectors).replace(
    /[\u007f-\uffff]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

  mkdirSync(vectorDirectory, { recursive: true });
  writeFileSync(file, `${json}\n`);
  execFileSync("pnpm", ["exec", "biome", "format", "--write", file], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
}

/* Rewrites the file first when updating, then reads what is committed. */
function expectCommitted<T>(fileName: string, vectors: T) {
  const file = join(vectorDirectory, fileName);

  if (updating) {
    writeVectors(file, vectors);
  }

  const committed: unknown = JSON.parse(readFileSync(file, "utf8"));

  // The round trip drops what JSON cannot hold, as the committed file did.
  expect(JSON.parse(JSON.stringify(vectors))).toEqual(committed);
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

const imageFormats: readonly ArchiveImageFormat[] = ["avif", "bmp", "gif", "jpeg", "png", "webp"];

const frameCounts = [0, 1, 2, 3, 4_294_967_295];

const imageSourceNames = [
  "photo.png",
  "photo.avif",
  "photo.AVIF",
  "photo",
  ".avif",
  "dir.avif/photo",
  "C:\\Photos\\IMG_0001.JPG",
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

describe("media-format still policy conformance vectors", () => {
  it("plans downloads and images on disk as committed", () => {
    expectCommitted("still-policy.json", {
      about: aboutModule("still-policy.ts"),
      expectedTargets: fileNames.map((fileName) => ({
        fileName,
        target: getExpectedArchiveTarget(fileName),
      })),
      media: mediaCases(),
      images: imageFormats.flatMap((format) =>
        frameCounts.flatMap((frameCount) =>
          imageSourceNames.map((fileName) => {
            const source = { fileName, format, frameCount };

            return { ...source, plan: planArchiveImage(source) };
          }),
        ),
      ),
    });
  });
});

/* video-policy.ts */

type ProbedVideoCodec = ArchiveVideoSource["videoCodec"];

type ProbedAudioCodec = ArchiveVideoSource["audioCodec"];

const probedVideoCodecs: readonly ProbedVideoCodec[] = [...VIDEO_CODECS, "other", null];

const probedAudioCodecs: readonly ProbedAudioCodec[] = [...AUDIO_CODECS, "other", null];

function videoSource(
  fileName: string,
  container: ArchiveVideoSource["container"],
  videoCodec: ProbedVideoCodec,
  audioCodec: ProbedAudioCodec,
): ArchiveVideoSource {
  return { fileName, container, videoCodec, audioCodec };
}

function archiveVideoSources(): readonly ArchiveVideoSource[] {
  const sources = [
    // Every container against every video codec.
    ...VIDEO_CONTAINERS.flatMap((container) =>
      probedVideoCodecs.map((videoCodec) => videoSource("clip.mov", container, videoCodec, "aac")),
    ),
    // Every audio codec, in MP4 and in Matroska.
    ...(["mp4", "matroska"] as const).flatMap((container) =>
      probedAudioCodecs.map((audioCodec) => videoSource("clip.mp4", container, "avc", audioCodec)),
    ),
    // Every container against copied, encoded and missing tracks.
    ...VIDEO_CONTAINERS.flatMap((container) =>
      (["avc", "vp9", null] as const).flatMap((videoCodec) =>
        (["aac", "opus", null] as const).map((audioCodec) =>
          videoSource("clip.mp4", container, videoCodec, audioCodec),
        ),
      ),
    ),
    // Every file name, for a file that is already MP4 and for one to convert.
    ...fileNames.flatMap((fileName) => [
      videoSource(fileName, "mp4", "avc", "aac"),
      videoSource(fileName, "mov", "vp9", "opus"),
    ]),
  ];

  // The sweeps overlap; each source is planned once, where it first appears.
  const seen = new Set<string>();

  return sources.filter((source) => {
    const key = JSON.stringify(source);
    const first = !seen.has(key);
    seen.add(key);

    return first;
  });
}

const reencodeSources: readonly ArchiveVideoSource[] = VIDEO_CONTAINERS.flatMap((container) => [
  videoSource("clip.mkv", container, "avc", "aac"),
  videoSource("clip.webm", container, "vp9", "opus"),
  videoSource("clip.mp4", container, null, "aac"),
  videoSource("clip", container, "hevc", null),
]);

const stripSources: readonly ArchiveVideoSource[] = VIDEO_CONTAINERS.flatMap((container) =>
  probedVideoCodecs.map((videoCodec) => videoSource("clip.mkv", container, videoCodec, "opus")),
);

describe("media-format video policy conformance vectors", () => {
  it("plans videos, re-encodes and stripped audio as committed", () => {
    expectCommitted("video-policy.json", {
      about: aboutModule("video-policy.ts"),
      mediabunnyVideoCodecs: [...VIDEO_CODECS],
      mediabunnyAudioCodecs: [...AUDIO_CODECS],
      archiveVideoCodecs: [...ARCHIVE_VIDEO_CODECS],
      archiveAudioCodecs: [...ARCHIVE_AUDIO_CODECS],
      defaultVideoCodec: ARCHIVE_DEFAULT_VIDEO_CODEC,
      videoContainers: [...VIDEO_CONTAINERS],
      isArchiveVideoCodec: [...VIDEO_CODECS, "other" as const].map((codec) => ({
        codec,
        archive: isArchiveVideoCodec(codec),
      })),
      archiveVideo: archiveVideoSources().map((source) => ({
        ...source,
        plan: planArchiveVideo(source),
      })),
      reencode: reencodeSources.flatMap((source) =>
        ARCHIVE_VIDEO_CODECS.map((codec) => ({
          ...source,
          codec,
          plan: planVideoReencode(source, codec),
        })),
      ),
      stripAudio: stripSources.map((source) => ({ ...source, plan: planStripAudio(source) })),
    });
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
      wasmPixelLimit: ARCHIVE_AVIF_WASM_PIXEL_LIMIT,
      options: ARCHIVE_AVIF_OPTIONS,
      sharpOptions: ARCHIVE_AVIF_SHARP_OPTIONS,
      attempts: await Promise.all(attemptScripts.map(runAttempts)),
    });
  });
});

/* animation-mp4.ts */

interface AnimationScenario {
  about: string;
  mimeType: AnimatedImageMimeType;
  width: number;
  height: number;
  /* Each frame's duration in microseconds as the decoder reports it; null when it has none. */
  durations: (number | null)[];
}

interface FakeFrame {
  index: number;
  displayWidth: number;
  displayHeight: number;
  duration: number | null;
  close(): void;
}

interface Recording {
  canvas: { width: number; height: number } | null;
  contextOptions: { type: string; alpha: boolean } | null;
  fills: { fillStyle: string; rect: number[] }[];
  draws: { frameIndex: number; x: number; y: number }[];
  frames: { timestampSeconds: number; durationSeconds: number; keyFrame: boolean }[];
  finalized: boolean;
  canceled: boolean;
}

let playing: AnimationScenario | null = null;

let recording: Recording | null = null;

function currentRecording(): Recording {
  if (recording === null) {
    throw new Error("No animation is being recorded.");
  }

  return recording;
}

/* Chromium's ImageDecoder, reduced to what encodeAnimationAsMp4 reads, playing the scenario. */
class FakeImageDecoder {
  static async isTypeSupported(): Promise<boolean> {
    return true;
  }

  readonly tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } };

  readonly #scenario: AnimationScenario;

  constructor() {
    if (playing === null) {
      throw new Error("No animation scenario is playing.");
    }

    this.#scenario = playing;
    this.tracks = {
      ready: Promise.resolve(),
      selectedTrack: { frameCount: playing.durations.length },
    };
  }

  async decode({ frameIndex }: { frameIndex: number }): Promise<{ image: FakeFrame }> {
    return {
      image: {
        index: frameIndex,
        displayWidth: this.#scenario.width,
        displayHeight: this.#scenario.height,
        duration: this.#scenario.durations[frameIndex] ?? null,
        close() {},
      },
    };
  }

  close() {}
}

/* A 2D canvas that records what is painted on it. */
class FakeOffscreenCanvas {
  readonly width: number;

  readonly height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  getContext(type: string, options: { alpha: boolean }) {
    const record = currentRecording();
    record.contextOptions = { type, alpha: options.alpha };

    const context = {
      fillStyle: "",
      fillRect(x: number, y: number, width: number, height: number) {
        record.fills.push({ fillStyle: context.fillStyle, rect: [x, y, width, height] });
      },
      drawImage(image: FakeFrame, x: number, y: number) {
        record.draws.push({ frameIndex: image.index, x, y });
      },
    };

    return context;
  }
}

/* The encoder seam animation-mp4.ts names for this, recording each frame Mediabunny would get. */
const recordingEncoder: Mp4Encoder = {
  async open(canvas) {
    const record = currentRecording();
    record.canvas = { width: canvas.width, height: canvas.height };

    return {
      async addFrame(timestampSeconds, durationSeconds, options) {
        record.frames.push({ timestampSeconds, durationSeconds, keyFrame: options.keyFrame });
      },
      async finalize() {
        record.finalized = true;

        return new ArrayBuffer(0);
      },
      async cancel() {
        record.canceled = true;
      },
    };
  },
};

const animationScenarios: readonly AnimationScenario[] = [
  { about: "one frame", mimeType: "image/gif", width: 10, height: 10, durations: [100_000] },
  {
    about: "durations around the 10 ms floor, missing ones, and GIF's longest delay",
    mimeType: "image/gif",
    width: 4,
    height: 4,
    durations: [null, 0, 1, 9_999, 10_000, 10_001, 20_000, 99_999, 100_000, null, 655_350_000],
  },
  {
    about: "odd sizes round up to even",
    mimeType: "image/gif",
    width: 3,
    height: 5,
    durations: [50_000, 50_000],
  },
  { about: "one pixel", mimeType: "image/png", width: 1, height: 1, durations: [null] },
  { about: "no pixels", mimeType: "image/webp", width: 0, height: 0, durations: [40_000] },
  {
    about: "large odd sizes",
    mimeType: "image/webp",
    width: 4_095,
    height: 65_535,
    durations: [16_667, 16_667, 16_666],
  },
  {
    about: "timestamps add up in microseconds before they become seconds",
    mimeType: "image/png",
    width: 640,
    height: 360,
    durations: Array.from({ length: 40 }, () => 33_333),
  },
  {
    about: "durations under the floor, many times",
    mimeType: "image/gif",
    width: 2,
    height: 2,
    durations: Array.from({ length: 12 }, (_, index) => index % 3),
  },
  { about: "no frames", mimeType: "image/gif", width: 8, height: 8, durations: [] },
];

async function recordAnimation(scenario: AnimationScenario) {
  playing = scenario;
  recording = {
    canvas: null,
    contextOptions: null,
    fills: [],
    draws: [],
    frames: [],
    finalized: false,
    canceled: false,
  };
  const record = recording;

  try {
    await encodeAnimationAsMp4(
      new Blob([new Uint8Array(1)], { type: scenario.mimeType }),
      scenario.mimeType,
      undefined,
      recordingEncoder,
    );

    return { ...scenario, recorded: record, error: null };
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    return { ...scenario, recorded: record, error: error.message };
  } finally {
    playing = null;
    recording = null;
  }
}

describe("media-format animation conformance vectors", () => {
  beforeAll(() => {
    vi.stubGlobal("ImageDecoder", FakeImageDecoder);
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("turns animations into frames with the committed sizes, timings and settings", async () => {
    const cases = [];

    for (const scenario of animationScenarios) {
      cases.push(await recordAnimation(scenario));
    }

    expectCommitted("animation-mp4.json", {
      about: aboutModule("animation-mp4.ts"),
      settings: ANIMATION_MP4_SETTINGS,
      cases,
    });
  });
});
