import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
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

const appIconBasePath = path.resolve(__dirname, "media", "oriel-icon");

const appBundleId = "dev.traydr.latchworks.oriel";

const windowsIconPath = `${appIconBasePath}.ico`;

const macIconPath = `${appIconBasePath}.icns`;

const linuxIconPath = `${appIconBasePath}.png`;

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

/** Native packages View's and Tidy's workers load from the app's resources, outside the asar. */
const runtimeDependencyRoots = ["ffmpeg-static", "@ffprobe-installer/ffprobe", "sharp"];

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

function getPackagerIconPath(): string | undefined {
  if (process.platform === "win32") {
    return existsSync(windowsIconPath) ? appIconBasePath : undefined;
  }

  if (process.platform === "darwin") {
    return existsSync(macIconPath) ? appIconBasePath : undefined;
  }

  return existsSync(linuxIconPath) ? linuxIconPath : undefined;
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
  },
  // Windows gets a Velopack installer in a later step; until then it gets a ZIP like macOS.
  makers: [
    new MakerZIP({}, ["darwin", "win32"]),
    new MakerDMG(
      {
        icon: existsSync(macIconPath) ? macIconPath : undefined,
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
