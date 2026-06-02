import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import type { ForgeConfig } from '@electron-forge/shared-types';

const appIconBasePath = path.resolve(__dirname, 'media', 'frame-view-icon');
const windowsIconPath = `${appIconBasePath}.ico`;
const macIconPath = `${appIconBasePath}.icns`;
const linuxIconPath = `${appIconBasePath}.png`;
const appName = 'frame-view';
const appExecutableName = `${appName}.exe`;
const appSetupExe = `${appName} Setup.exe`;
const stagedRuntimeNodeModulesPath = path.resolve(__dirname, '.packaged-runtime', 'node_modules');
const runtimeDependencyRoots = ['ffmpeg-static', 'ffprobe-static', 'sharp'];

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
  cpSync(sourcePath, targetPath, {
    recursive: true,
  });

  const packageJsonPath = path.join(sourcePath, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return;
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };

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

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      unpack: '**/*.{exe,node,dll}',
    },
    extraResource: [stagedRuntimeNodeModulesPath],
    icon: getPackagerIconPath(),
    executableName: appName,
  },
  rebuildConfig: {},
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
