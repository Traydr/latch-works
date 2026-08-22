import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { z } from 'zod';

/** The dependency lists forge walks when staging runtime packages. */
const PackageManifestSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
});

const appIconBasePath = path.resolve(__dirname, 'media', 'frame-view-icon');
const appBundleId = 'dev.traydr.latchworks.frameview';
const windowsIconPath = `${appIconBasePath}.ico`;
const macIconPath = `${appIconBasePath}.icns`;
const linuxIconPath = `${appIconBasePath}.png`;
const appMediaPath = path.resolve(__dirname, 'media');
const localMacEntitlements = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation',
];
const appName = 'frame-view';
const appExecutableName = `${appName}.exe`;
const appSetupExe = `${appName} Setup.exe`;
const stagedRuntimeNodeModulesPath = path.resolve(__dirname, '.packaged-runtime', 'node_modules');
const runtimeDependencyRoots = ['ffmpeg-static', '@ffprobe-installer/ffprobe', 'sharp'];

type PackagerConfig = NonNullable<ForgeConfig['packagerConfig']>;

function resolvePackageDirectory(packageName: string): string {
  const packagePathSegments = packageName.startsWith('@') ? packageName.split('/') : [packageName];
  return path.resolve(__dirname, 'node_modules', ...packagePathSegments);
}

function copyRuntimePackage(packageName: string, visited: Set<string>): void {
  if (visited.has(packageName)) {
    return;
  }

  const sourcePath = resolvePackageDirectory(packageName);
  if (!existsSync(sourcePath)) {
    return;
  }

  visited.add(packageName);
  const targetPath = path.join(stagedRuntimeNodeModulesPath, ...packageName.split('/'));
  // Keep packaged runtime dependencies self-contained so codesign can seal the .app bundle.
  cpSync(sourcePath, targetPath, {
    dereference: true,
    recursive: true,
  });

  const packageJsonPath = path.join(sourcePath, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return;
  }

  const packageJson = PackageManifestSchema.parse(
    JSON.parse(readFileSync(packageJsonPath, 'utf8')),
  );

  for (const dependencyName of Object.keys(packageJson.dependencies ?? {})) {
    copyRuntimePackage(dependencyName, visited);
  }

  for (const dependencyName of Object.keys(packageJson.optionalDependencies ?? {})) {
    copyRuntimePackage(dependencyName, visited);
  }
}

function stageRuntimeDependencies(): void {
  rmSync(path.resolve(__dirname, '.packaged-runtime'), { force: true, recursive: true });
  mkdirSync(stagedRuntimeNodeModulesPath, { recursive: true });
  const visited = new Set<string>();

  for (const dependencyName of runtimeDependencyRoots) {
    copyRuntimePackage(dependencyName, visited);
  }
}

function getPackagerIconPath(): string | undefined {
  if (process.platform === 'win32') {
    return existsSync(windowsIconPath) ? appIconBasePath : undefined;
  }

  if (process.platform === 'darwin') {
    return existsSync(macIconPath) ? appIconBasePath : undefined;
  }

  return existsSync(linuxIconPath) ? linuxIconPath : undefined;
}

function getMacCodeSignConfig(): PackagerConfig['osxSign'] | undefined {
  if (process.platform !== 'darwin') {
    return undefined;
  }

  const identity = process.env.FRAME_VIEW_MACOS_SIGN_IDENTITY?.trim();
  if (identity) {
    return { identity };
  }

  return {
    identity: '-',
    identityValidation: false,
    optionsForFile: (filePath) =>
      filePath.endsWith('.app') ? { entitlements: localMacEntitlements } : {},
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
  };
}

const config: ForgeConfig = {
  packagerConfig: {
    appBundleId,
    asar: {
      unpack: '**/*.{exe,node,dll}',
    },
    // Vite output lives in `.vite`; ffmpeg/ffprobe/sharp are staged via extraResource.
    // Keep prune off so packager does not walk dev node_modules (galactus + native rebuild).
    ignore: (file) => {
      if (!file) {
        return false;
      }
      if (file.startsWith('/.vite') || file === '/package.json') {
        return false;
      }
      return true;
    },
    prune: false,
    extraResource: [stagedRuntimeNodeModulesPath, appMediaPath],
    icon: getPackagerIconPath(),
    executableName: appName,
    osxSign: getMacCodeSignConfig(),
  },
  rebuildConfig: {
    onlyModules: [],
  },
  hooks: {
    prePackage: async () => {
      stageRuntimeDependencies();
    },
  },
  makers: [
    new MakerSquirrel({
      name: appName,
      exe: appExecutableName,
      setupExe: appSetupExe,
      setupIcon: existsSync(windowsIconPath) ? windowsIconPath : undefined,
    }),
    new MakerZIP({}, ['darwin']),
    new MakerDMG(
      {
        icon: existsSync(macIconPath) ? macIconPath : undefined,
      },
      ['darwin'],
    ),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/main/catalog/catalog.worker.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/main/thumbnail/thumbnail.worker.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
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
