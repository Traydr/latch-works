import { execFileSync, execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerZIP } from "@electron-forge/maker-zip";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { z } from "zod";

/** The dependency lists forge walks when staging runtime packages. */
const PackageManifestSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
});

const AppManifestSchema = z.object({ version: z.string() });

const appIconBasePath = path.resolve(__dirname, "media", "oriel-icon");

const appBundleId = "dev.traydr.latchworks.oriel";

const windowsIconPath = `${appIconBasePath}.ico`;

const macIconPath = `${appIconBasePath}.icns`;

const linuxIconPath = `${appIconBasePath}.png`;

/** The Icon Composer bundle: light, dark and tinted looks, for macOS 26 and later. */
const macGlassIconPath = path.resolve(__dirname, "media", "oriel.icon");

/** The DMG's artwork and Windows' installer art and text, from `pnpm icons`. */
const installerPath = path.resolve(__dirname, "installer");

const appMediaPath = path.resolve(__dirname, "media");

const localMacEntitlements = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
];

const appName = "oriel";

const stagedRuntimePath = path.resolve(__dirname, ".packaged-runtime");

const stagedNodeModulesPath = path.join(stagedRuntimePath, "node_modules");

const stagedCodecsPath = path.join(stagedRuntimePath, "codecs");

/**
 * Native packages the app loads from its resources, outside the asar: View's and Tidy's media
 * tools, and on Windows Velopack, which installs and updates it.
 */
const runtimeDependencyRoots = [
  "ffmpeg-static",
  "@ffprobe-installer/ffprobe",
  "sharp",
  ...(process.platform === "win32" ? ["velopack"] : []),
];

type PackagerConfig = NonNullable<ForgeConfig["packagerConfig"]>;

// Walk up from `fromDirectory` looking in each `node_modules`, following pnpm's symlinks into the
// virtual store so transitive and optional dependencies resolve under the isolated layout as well
// as a hoisted one. Missing packages (other platforms' optional binaries) return null.
function findPackageDirectory(packageName: string, fromDirectory: string): string | null {
  const packagePathSegments = packageName.split("/");
  let currentDirectory = fromDirectory;

  for (;;) {
    const candidatePath = path.join(currentDirectory, "node_modules", ...packagePathSegments);

    if (existsSync(candidatePath)) {
      return realpathSync(candidatePath);
    }

    const parentDirectory = path.dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      return null;
    }

    currentDirectory = parentDirectory;
  }
}

function copyRuntimePackage(
  packageName: string,
  fromDirectory: string,
  visited: Set<string>,
): void {
  if (visited.has(packageName)) {
    return;
  }

  const sourcePath = findPackageDirectory(packageName, fromDirectory);

  if (!sourcePath) {
    return;
  }

  visited.add(packageName);
  // Self-contained copies, so codesign can seal the .app bundle.
  cpSync(sourcePath, path.join(stagedNodeModulesPath, ...packageName.split("/")), {
    dereference: true,
    recursive: true,
  });

  const packageJsonPath = path.join(sourcePath, "package.json");

  if (!existsSync(packageJsonPath)) {
    return;
  }

  const manifest = PackageManifestSchema.parse(JSON.parse(readFileSync(packageJsonPath, "utf8")));

  for (const dependencyName of Object.keys(manifest.dependencies ?? {})) {
    copyRuntimePackage(dependencyName, sourcePath, visited);
  }

  for (const dependencyName of Object.keys(manifest.optionalDependencies ?? {})) {
    copyRuntimePackage(dependencyName, sourcePath, visited);
  }
}

// Vite bundles workspace packages from their `dist`, which nothing else rebuilds before a direct
// `electron-forge package` or `make`.
function buildWorkspaceDependencies(): void {
  execSync('pnpm --filter "@latch-works/oriel^..." run build', {
    cwd: path.resolve(__dirname, "../.."),
    stdio: "inherit",
  });
}

function stageRuntime(): void {
  rmSync(stagedRuntimePath, { force: true, recursive: true });
  mkdirSync(stagedNodeModulesPath, { recursive: true });
  mkdirSync(stagedCodecsPath, { recursive: true });
  const visited = new Set<string>();

  for (const dependencyName of runtimeDependencyRoots) {
    copyRuntimePackage(dependencyName, __dirname, visited);
  }

  for (const dependencyName of runtimeDependencyRoots) {
    if (!visited.has(dependencyName)) {
      throw new Error(`Runtime dependency ${dependencyName} was not found for staging`);
    }
  }

  // The libavif encoder the AVIF workers load from disk: its wasm, and its emscripten module as
  // `.mjs` so Node reads it as the ES module it is.
  const resolveFromApp = createRequire(path.join(__dirname, "package.json"));
  cpSync(
    resolveFromApp.resolve("@jsquash/avif/codec/enc/avif_enc.wasm"),
    path.join(stagedCodecsPath, "avif_enc.wasm"),
  );
  cpSync(
    resolveFromApp.resolve("@jsquash/avif/codec/enc/avif_enc.js"),
    path.join(stagedCodecsPath, "avif_enc.mjs"),
  );
}

/**
 * Whether this Mac can compile the Icon Composer bundle: packager runs Xcode's `actool`, which
 * reads `.icon` from version 26, on macOS 26 (Darwin 25) and later. Elsewhere the `.icns` serves.
 */
function canCompileGlassIcon(): boolean {
  if (process.platform !== "darwin" || Number(os.release().split(".")[0]) < 25) {
    return false;
  }

  try {
    const output = execFileSync("xcrun", ["actool", "--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    const major = /<key>short-bundle-version<\/key>\s*<string>(\d+)/.exec(output)?.[1];

    return Number(major) >= 26;
  } catch {
    return false;
  }
}

function getPackagerIconPath(): PackagerConfig["icon"] {
  if (process.platform === "win32") {
    return existsSync(windowsIconPath) ? appIconBasePath : undefined;
  }

  if (process.platform === "darwin") {
    if (!existsSync(macIconPath)) {
      return undefined;
    }

    return canCompileGlassIcon() ? [macIconPath, macGlassIconPath] : macIconPath;
  }

  return existsSync(linuxIconPath) ? linuxIconPath : undefined;
}

/** Velopack's `vpk`, pinned to the `velopack` package the app runs; see docs/runbooks/oriel.md. */
const VPK_VERSION = "1.3.39-g8d2844f";

/**
 * Packs Forge's Windows build with Velopack: Setup.exe with the brand splash, a portable ZIP and
 * an MSI that installs per user or for the machine. Needs the .NET SDK and `vpk`.
 */
function packWithVelopack(): string {
  const { version } = AppManifestSchema.parse(
    JSON.parse(readFileSync(path.join(__dirname, "package.json"), "utf8")),
  );

  const outputDir = path.resolve(__dirname, "out", "make", "velopack");
  const art = (file: string) => path.join(installerPath, file);

  try {
    execFileSync("vpk", ["--help"], { stdio: "ignore" });
  } catch (cause) {
    throw new Error(
      `Velopack's vpk did not run (${cause instanceof Error ? cause.message : String(cause)}). Install it with: dotnet tool install -g vpk --version ${VPK_VERSION}`,
    );
  }

  execFileSync(
    "vpk",
    [
      "pack",
      "--packId",
      "Oriel",
      "--packVersion",
      version,
      "--packTitle",
      "Oriel",
      "--packAuthors",
      "Traydr",
      "--packDir",
      path.resolve(__dirname, "out", `Oriel-win32-${process.arch}`),
      "--mainExe",
      `${appName}.exe`,
      "--icon",
      windowsIconPath,
      "--splashImage",
      art("splash.gif"),
      "--outputDir",
      outputDir,
      "--msi",
      "--instLocation",
      "Either",
      "--instWelcome",
      art("welcome.txt"),
      "--instConclusion",
      art("conclusion.txt"),
      "--msiTopBanner",
      art("msi-banner.bmp"),
      "--msiDialogBackground",
      art("msi-dialog.bmp"),
    ],
    { stdio: "inherit" },
  );

  return outputDir;
}

/**
 * Oriel is not signed with a Developer ID yet: without `ORIEL_MACOS_SIGN_IDENTITY` the bundle is
 * signed ad hoc, with the entitlements that let its helpers load a framework of no Team ID.
 */
function getMacCodeSignConfig(): PackagerConfig["osxSign"] | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }

  const identity = process.env.ORIEL_MACOS_SIGN_IDENTITY?.trim();

  if (identity) {
    return { identity };
  }

  return {
    identity: "-",
    identityValidation: false,
    optionsForFile: (filePath) =>
      filePath.endsWith(".app") ? { entitlements: localMacEntitlements } : {},
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
  };
}

const config: ForgeConfig = {
  packagerConfig: {
    appBundleId,
    asar: {
      unpack: "**/*.{exe,node,dll}",
    },
    // Vite output lives in `.vite`; the native runtime is staged through extraResource. Prune stays
    // off so packager does not walk the dev node_modules.
    ignore: (file) => {
      if (!file) {
        return false;
      }

      if (file.startsWith("/.vite") || file === "/package.json") {
        return false;
      }

      return true;
    },
    prune: false,
    extraResource: [stagedNodeModulesPath, stagedCodecsPath, appMediaPath],
    icon: getPackagerIconPath(),
    executableName: appName,
    osxSign: getMacCodeSignConfig(),
  },
  rebuildConfig: {
    onlyModules: [],
  },
  hooks: {
    prePackage: async () => {
      buildWorkspaceDependencies();
      stageRuntime();
    },
    // Windows' installers come from Velopack, over the build Forge just packaged.
    postMake: async (_config, results) => {
      if (process.platform === "win32") {
        console.log(`Velopack installers in ${packWithVelopack()}`);
      }

      return results;
    },
  },
  makers: [
    // Forge needs a maker for Windows to reach postMake, where Velopack packs the build.
    new MakerZIP({}, ["darwin", "win32"]),
    // A 660 × 400 window: the app and Applications at 128 px, an arrow between them in the
    // artwork, and a mid-tone plate under each label, which Finder draws white or black.
    new MakerDMG(
      {
        title: "Oriel",
        icon: existsSync(macIconPath) ? macIconPath : undefined,
        background: path.join(installerPath, "dmg-background.png"),
        iconSize: 128,
        format: "ULFO",
        contents: (options) => [
          { x: 180, y: 180, type: "file", path: options.appPath },
          { x: 480, y: 180, type: "link", path: "/Applications" },
        ],
        additionalDMGOptions: { window: { size: { width: 660, height: 400 } } },
      },
      ["darwin"],
    ),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        { entry: "src/main.ts", config: "vite.main.config.mts", target: "main" },
        {
          entry: "src/modes/view/main/catalog/catalog.worker.ts",
          config: "vite.main.config.mts",
          target: "main",
        },
        {
          entry: "src/modes/view/main/thumbnail/thumbnail.worker.ts",
          config: "vite.main.config.mts",
          target: "main",
        },
        {
          entry: "src/modes/tidy/engine/engine-process.ts",
          config: "vite.main.config.mts",
          target: "main",
        },
        {
          entry: "src/modes/tidy/engine/avif-worker.ts",
          config: "vite.main.config.mts",
          target: "main",
        },
        { entry: "src/preload.ts", config: "vite.preload.config.mts", target: "preload" },
        {
          entry: "src/modes/tidy/transcoder-preload.ts",
          config: "vite.preload.config.mts",
          target: "preload",
        },
      ],
      renderer: [
        { name: "main_window", config: "vite.renderer.config.mts" },
        { name: "transcoder", config: "vite.transcoder.config.mts" },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
