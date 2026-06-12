import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronPackageJson = require.resolve('electron/package.json');
const electronDir = path.dirname(electronPackageJson);
const { version } = require(electronPackageJson);
const { downloadArtifact } = require('@electron/get');

function getPlatformPath() {
  switch (process.platform) {
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron';
    case 'win32':
      return 'electron.exe';
    default:
      return 'electron';
  }
}

function getInstallMarkerPath() {
  const platformPath = getPlatformPath();

  if (process.platform === 'darwin') {
    return path.join(
      electronDir,
      'dist',
      'Electron.app',
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
    );
  }

  return path.join(electronDir, 'dist', platformPath);
}

function isElectronInstalled() {
  try {
    const distVersion = readFileSync(path.join(electronDir, 'dist', 'version'), 'utf8').replace(
      /^v/,
      '',
    );
    const pathTxt = readFileSync(path.join(electronDir, 'path.txt'), 'utf8');

    return (
      distVersion === version && pathTxt === getPlatformPath() && existsSync(getInstallMarkerPath())
    );
  } catch {
    return false;
  }
}

async function repairElectronInstall() {
  const platform = process.env.npm_config_platform || process.platform;
  let arch = process.env.npm_config_arch || process.arch;

  if (
    platform === 'darwin' &&
    process.platform === 'darwin' &&
    arch === 'x64' &&
    process.env.npm_config_arch === undefined
  ) {
    try {
      const output = spawnSync('sysctl', ['-in', 'sysctl.proc_translated'], { encoding: 'utf8' });
      if (output.stdout?.trim() === '1') {
        arch = 'arm64';
      }
    } catch {
      // Ignore sysctl failures.
    }
  }

  const distPath = path.join(electronDir, 'dist');
  rmSync(distPath, { recursive: true, force: true });
  rmSync(path.join(electronDir, 'path.txt'), { force: true });
  mkdirSync(distPath, { recursive: true });

  const zipPath = await downloadArtifact({
    version,
    artifactName: 'electron',
    force: process.env.force_no_cache === 'true',
    cacheRoot: process.env.electron_config_cache,
    checksums:
      process.env.electron_use_remote_checksums ||
      process.env.npm_config_electron_use_remote_checksums
        ? undefined
        : require(path.join(electronDir, 'checksums.json')),
    platform,
    arch,
  });

  if (process.platform === 'darwin' || process.platform === 'linux') {
    const unzip = spawnSync('unzip', ['-oq', zipPath, '-d', distPath], { stdio: 'inherit' });
    if (unzip.status !== 0) {
      throw new Error(`unzip failed with exit code ${unzip.status ?? 'unknown'}`);
    }
  } else {
    const extract = require('extract-zip');
    await extract(zipPath, { dir: distPath });
  }

  const srcTypeDefPath = path.join(distPath, 'electron.d.ts');
  const targetTypeDefPath = path.join(electronDir, 'electron.d.ts');
  if (existsSync(srcTypeDefPath)) {
    rmSync(targetTypeDefPath, { force: true });
    require('node:fs').renameSync(srcTypeDefPath, targetTypeDefPath);
  }

  writeFileSync(path.join(electronDir, 'path.txt'), getPlatformPath());
}

const scriptPath = fileURLToPath(import.meta.url);

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD === '1') {
    process.exit(0);
  }

  if (!isElectronInstalled()) {
    console.log('[ensure-electron] Repairing incomplete Electron install...');
    await repairElectronInstall();

    if (!isElectronInstalled()) {
      console.error('[ensure-electron] Electron install is still incomplete after repair.');
      process.exit(1);
    }

    console.log('[ensure-electron] Electron install ready.');
  }
}
