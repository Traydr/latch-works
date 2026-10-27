import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { z } from "zod";

/** A download and the SHA-256 it has to match before anything runs what it holds. */
interface PinnedArchive {
  url: string;
  sha256: string;
}

interface MediaToolsPin {
  version: string;
  /** The zips that hold ffmpeg and ffprobe, wherever in each zip's folder tree they sit. */
  archives: PinnedArchive[];
}

/**
 * ffmpeg and ffprobe newer than `ffmpeg-static`'s, where a build is pinned. `ffmpeg-static` ships
 * ffmpeg 6.0, whose SVT-AV1 1.4 on Apple Silicon runs without SIMD, about 16 times slower than a
 * current build at the same output; its Windows build has no SVT-AV1 or dav1d at all. The Mac's
 * are Martin Riedl's static builds, which ffmpeg.org's download page links to: ffmpeg 9.0.2 with
 * SVT-AV1 4.2, dav1d, x264 and x265, GPLv3. Windows' is gyan.dev's full static build, which the
 * same page links to, from its GitHub releases: ffmpeg 9.0.2 with SVT-AV1 4.2 (a git build after
 * 4.2.0), dav1d, x264 and x265, GPLv3. Elsewhere Tidy keeps using `ffmpeg-static` and
 * `@ffprobe-installer`.
 */
const PINS = new Map<string, MediaToolsPin>([
  [
    "darwin-arm64",
    {
      version: "9.0.2",
      archives: [
        {
          url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip",
          sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
        },
        {
          url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffprobe.zip",
          sha256: "fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6",
        },
      ],
    },
  ],
  [
    "win32-x64",
    {
      version: "9.0.2",
      archives: [
        {
          url: "https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-full_build.zip",
          sha256: "759d0a9831c436a0eb331ad36f236c06cb04aaa0005da46571f0e9d3d9206f6b",
        },
      ],
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

/** The pinned tools' file names on `platform`: `ffmpeg` and `ffprobe`, with `.exe` on Windows. */
export function mediaToolFiles(platform: string): [ffmpeg: string, ffprobe: string] {
  const extension = platform === "win32" ? ".exe" : "";

  return [`ffmpeg${extension}`, `ffprobe${extension}`];
}

function sha256Of(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/**
 * Unpacks a zip into `folder`. `ditto` keeps a Mac binary's signature and mode; Windows 10 and
 * later ship bsdtar as `tar.exe`, which reads zip, unlike the GNU tar a Git Bash puts first on
 * the PATH.
 */
function unzip(zipPath: string, folder: string): void {
  if (process.platform === "win32") {
    const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    execFileSync(tar, ["-x", "-f", zipPath, "-C", folder]);

    return;
  }

  execFileSync("ditto", ["-x", "-k", zipPath, folder]);
}

/** Every file under `folder` named one of `names`, by name. */
function findFiles(folder: string, names: string[]): Map<string, string> {
  const found = new Map<string, string>();

  for (const entry of readdirSync(folder, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && names.includes(entry.name)) {
      found.set(entry.name, path.join(entry.parentPath, entry.name));
    }
  }

  return found;
}

/** Downloads one zip, refusing it unless it hashes to the pin, and unpacks it into `folder`. */
async function fetchArchive(archive: PinnedArchive, folder: string): Promise<void> {
  const response = await fetch(archive.url);

  if (!response.ok) {
    throw new Error(`Downloading ${archive.url} failed: ${response.status} ${response.statusText}`);
  }

  const zipPath = path.join(folder, "download.zip");
  writeFileSync(zipPath, new Uint8Array(await response.arrayBuffer()));

  const actual = sha256Of(zipPath);

  if (actual !== archive.sha256) {
    rmSync(zipPath, { force: true });

    throw new Error(`${archive.url} hashed to ${actual}, not the pinned ${archive.sha256}`);
  }

  unzip(zipPath, folder);
  rmSync(zipPath, { force: true });
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
  const [ffmpegFile, ffprobeFile] = mediaToolFiles(platform);
  const ffmpegPath = path.join(folder, ffmpegFile);
  const ffprobePath = path.join(folder, ffprobeFile);

  if (existsSync(markerPath)) {
    const marker = MarkerSchema.parse(JSON.parse(readFileSync(markerPath, "utf8")));

    const intact =
      marker.version === pin.version &&
      existsSync(ffmpegPath) &&
      existsSync(ffprobePath) &&
      sha256Of(ffmpegPath) === marker.ffmpeg &&
      sha256Of(ffprobePath) === marker.ffprobe;

    if (intact) {
      return folder;
    }
  }

  rmSync(folder, { force: true, recursive: true });
  const unpacked = path.join(folder, "unpacked");
  mkdirSync(unpacked, { recursive: true });
  console.log(`Fetching ffmpeg ${pin.version} for ${key}`);

  for (const archive of pin.archives) {
    await fetchArchive(archive, unpacked);
  }

  // Keep the two tools, out of whatever folders the zips held them in, and drop the rest.
  const found = findFiles(unpacked, [ffmpegFile, ffprobeFile]);

  for (const file of [ffmpegFile, ffprobeFile]) {
    const source = found.get(file);

    if (source === undefined) {
      throw new Error(`The pinned ffmpeg ${pin.version} for ${key} holds no ${file}`);
    }

    renameSync(source, path.join(folder, file));
    chmodSync(path.join(folder, file), 0o755);
  }

  rmSync(unpacked, { force: true, recursive: true });

  const marker = {
    version: pin.version,
    ffmpeg: sha256Of(ffmpegPath),
    ffprobe: sha256Of(ffprobePath),
  } satisfies z.infer<typeof MarkerSchema>;

  writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);

  return folder;
}
