import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { MediaToolkit, SharpLibrary } from "@latch-works/glazier-core";
import { z } from "zod";

/** How a utility process was started: whether from a packaged app, and where its resources are. */
export interface RuntimeLocation {
  packaged: boolean;
  resourcesPath: string;
}

const nativeRequire = createRequire(__filename);

/** `ffmpeg-static` exports the binary path directly or as a CommonJS default export. */
const BinaryPathModuleSchema = z.union([
  z.string(),
  z.object({ default: z.string() }).transform((module) => module.default),
]);

/** `@ffprobe-installer/ffprobe` exports `{ path }`, directly or as a CommonJS default export. */
const FfprobeModuleSchema = z.union([
  z.object({ path: z.string() }).transform((module) => module.path),
  z.object({ default: z.object({ path: z.string() }) }).transform((module) => module.default.path),
]);

/**
 * A packaged app stages its native packages in `Resources/node_modules`, outside the asar;
 * development resolves them from the app's own `node_modules`.
 */
function requireRuntimePackage(location: RuntimeLocation, packageName: string) {
  if (!location.packaged) {
    return nativeRequire(packageName);
  }

  return createRequire(
    path.join(location.resourcesPath, "node_modules", packageName, "package.json"),
  )(packageName);
}

function existingPath(candidate: string | null): string | null {
  return candidate !== null && existsSync(candidate) ? candidate : null;
}

export function loadSharp(location: RuntimeLocation): SharpLibrary {
  const loaded = requireRuntimePackage(location, "sharp");

  // `require("sharp")` yields the library, or an ES-interop wrapper holding it as `default`.
  return loaded.default ?? loaded;
}

/**
 * The pinned ffmpeg and ffprobe the build fetched (see `media-tools.ts`): `Resources/media-tools`
 * when packaged, the app's `.media-tools` cache in development. Absent on platforms without a pin.
 */
function pinnedToolPath(location: RuntimeLocation, tool: "ffmpeg" | "ffprobe"): string | null {
  const folder = location.packaged
    ? path.join(location.resourcesPath, "media-tools")
    : // The engine runs from `.vite/build`, two folders under the app.
      path.resolve(__dirname, "..", "..", ".media-tools", `${process.platform}-${process.arch}`);

  return existingPath(path.join(folder, process.platform === "win32" ? `${tool}.exe` : tool));
}

export function loadToolkit(location: RuntimeLocation): MediaToolkit {
  const ffmpeg = BinaryPathModuleSchema.safeParse(requireRuntimePackage(location, "ffmpeg-static"));

  const ffprobe = FfprobeModuleSchema.safeParse(
    requireRuntimePackage(location, "@ffprobe-installer/ffprobe"),
  );

  return {
    sharp: loadSharp(location),
    ffmpegPath:
      pinnedToolPath(location, "ffmpeg") ?? existingPath(ffmpeg.success ? ffmpeg.data : null),
    ffprobePath:
      pinnedToolPath(location, "ffprobe") ?? existingPath(ffprobe.success ? ffprobe.data : null),
  };
}

/** The libavif emscripten module, staged beside its wasm when packaged. */
export function avifCodecModulePath(location: RuntimeLocation): string {
  return location.packaged
    ? path.join(location.resourcesPath, "codecs", "avif_enc.mjs")
    : nativeRequire.resolve("@jsquash/avif/codec/enc/avif_enc.js");
}

/** The libavif wasm: staged in `Resources/codecs` when packaged, in `node_modules` otherwise. */
export function avifWasmPath(location: RuntimeLocation): string {
  return location.packaged
    ? path.join(location.resourcesPath, "codecs", "avif_enc.wasm")
    : nativeRequire.resolve("@jsquash/avif/codec/enc/avif_enc.wasm");
}

const ArgsSchema = z.object({
  packaged: z.enum(["0", "1"]).transform((value) => value === "1"),
  dataDir: z.string().default(""),
  concurrency: z.coerce.number().int().positive().default(2),
});

/** Utility processes get their settings as `--name=value` arguments from the main process. */
export function readProcessArgs(argv: readonly string[]) {
  const entries = argv.flatMap((arg) => {
    const match = /^--([a-z-]+)=(.*)$/i.exec(arg);

    return match?.[1] !== undefined && match[2] !== undefined
      ? [[match[1].replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()), match[2]]]
      : [];
  });

  return ArgsSchema.parse(Object.fromEntries(entries));
}
