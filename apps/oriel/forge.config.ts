import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
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

type PackagerConfig = NonNullable<ForgeConfig["packagerConfig"]>;

// Vite bundles workspace packages from their `dist`, which nothing else rebuilds before a direct
// `electron-forge package` or `make`.
function buildWorkspaceDependencies(): void {
  execSync('pnpm --filter "@latch-works/oriel^..." run build', {
    cwd: path.resolve(__dirname, "../.."),
    stdio: "inherit",
  });
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
    // Vite output lives in `.vite`. Prune stays off so packager does not walk the dev
    // node_modules.
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
    extraResource: [appMediaPath],
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
        { entry: "src/preload.ts", config: "vite.preload.config.mts", target: "preload" },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.mts" }],
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
