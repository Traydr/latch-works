import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

/** A tool's download and the SHA-256 its zip has to match before anything runs it. */
interface PinnedTool {
  url: string;
  sha256: string;
}

interface MediaToolsPin {
  version: string;
  ffmpeg: PinnedTool;
  ffprobe: PinnedTool;
}

/**
 * ffmpeg and ffprobe newer than `ffmpeg-static`'s, where a build is pinned. `ffmpeg-static` ships
 * ffmpeg 6.0, whose SVT-AV1 1.4 on Apple Silicon runs without SIMD, about 16 times slower than a
 * current build at the same output. These are Martin Riedl's static builds, which ffmpeg.org's
 * download page links to: ffmpeg 9.0.2 with SVT-AV1 4.2, dav1d, x264 and x265, GPLv3. Elsewhere
 * Tidy keeps using `ffmpeg-static` and `@ffprobe-installer`.
 */
const PINS = new Map<string, MediaToolsPin>([
  [
    "darwin-arm64",
    {
      version: "9.0.2",
      ffmpeg: {
        url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip",
        sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
      },
      ffprobe: {
        url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffprobe.zip",
        sha256: "fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6",
      },
    },
  ],
]);

/** Where downloaded tools are kept between builds, one folder per platform; not in git. */
const CACHE_PATH = path.resolve(__dirname, ".media-tools");

const MarkerSchema = z.object({
  version: z.string(),
  ffmpeg: z.string(),
  ffprobe: z.string(),
});

function sha256Of(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/** Downloads one zip, refusing it unless it hashes to the pin, and unpacks its one binary. */
async function fetchTool(name: "ffmpeg" | "ffprobe", tool: PinnedTool, folder: string) {
  const response = await fetch(tool.url);

  if (!response.ok) {
    throw new Error(`Downloading ${name} failed: ${response.status} ${response.statusText}`);
  }

  const zipPath = path.join(folder, `${name}.zip`);
  writeFileSync(zipPath, new Uint8Array(await response.arrayBuffer()));

  const actual = sha256Of(zipPath);

  if (actual !== tool.sha256) {
    rmSync(zipPath, { force: true });

    throw new Error(`${name}.zip hashed to ${actual}, not the pinned ${tool.sha256}`);
  }

  // `ditto` keeps the binary's signature and mode; only macOS builds are pinned.
  execFileSync("ditto", ["-x", "-k", zipPath, folder]);
  rmSync(zipPath, { force: true });
  chmodSync(path.join(folder, name), 0o755);
}

/**
 * The folder with this platform's pinned ffmpeg and ffprobe, downloading them on first use, or
 * null where none is pinned. The binaries' hashes are recorded when they are unpacked and checked
 * on every later build, so a changed binary is fetched again rather than shipped.
 */
export async function ensureMediaTools(platform: string, arch: string): Promise<string | null> {
  const key = `${platform}-${arch}`;
  const pin = PINS.get(key);

  if (pin === undefined) {
    return null;
  }

  const folder = path.join(CACHE_PATH, key);
  const markerPath = path.join(folder, "pin.json");

  if (existsSync(markerPath)) {
    const marker = MarkerSchema.parse(JSON.parse(readFileSync(markerPath, "utf8")));

    const intact =
      marker.version === pin.version &&
      existsSync(path.join(folder, "ffmpeg")) &&
      existsSync(path.join(folder, "ffprobe")) &&
      sha256Of(path.join(folder, "ffmpeg")) === marker.ffmpeg &&
      sha256Of(path.join(folder, "ffprobe")) === marker.ffprobe;

    if (intact) {
      return folder;
    }
  }

  rmSync(folder, { force: true, recursive: true });
  mkdirSync(folder, { recursive: true });
  console.log(`Fetching ffmpeg ${pin.version} for ${key}`);
  await fetchTool("ffmpeg", pin.ffmpeg, folder);
  await fetchTool("ffprobe", pin.ffprobe, folder);

  const marker = {
    version: pin.version,
    ffmpeg: sha256Of(path.join(folder, "ffmpeg")),
    ffprobe: sha256Of(path.join(folder, "ffprobe")),
  } satisfies z.infer<typeof MarkerSchema>;

  writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);

  return folder;
}
