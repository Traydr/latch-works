import { existsSync } from "node:fs";
import path from "node:path";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";

const appIconBasePath = path.resolve(__dirname, "media", "lockstep-icon");
const appBundleId = "dev.traydr.latchworks.lockstep";
const windowsIconPath = `${appIconBasePath}.ico`;
const macIconPath = `${appIconBasePath}.icns`;
const linuxIconPath = `${appIconBasePath}.png`;
const localMacEntitlements = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
];

type PackagerConfig = NonNullable<ForgeConfig["packagerConfig"]>;

function getPackagerIconPath(): string | undefined {
  if (process.platform === "win32") {
    return existsSync(windowsIconPath) ? appIconBasePath : undefined;
  }

  if (process.platform === "darwin") {
    return existsSync(macIconPath) ? appIconBasePath : undefined;
  }

  return existsSync(linuxIconPath) ? linuxIconPath : undefined;
}

function getMacCodeSignConfig(): PackagerConfig["osxSign"] | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }

  const identity = process.env.LOCKSTEP_MACOS_SIGN_IDENTITY?.trim();
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
    asar: true,
    executableName: "lockstep",
    icon: getPackagerIconPath(),
    osxSign: getMacCodeSignConfig(),
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: "lockstep",
      setupIcon: existsSync(windowsIconPath) ? windowsIconPath : undefined,
    }),
    new MakerZIP({}, ["darwin"]),
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
        {
          entry: "src/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts",
        },
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
