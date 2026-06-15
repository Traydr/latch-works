import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronDir = path.join(appRoot, "node_modules/electron");
const installScript = path.join(electronDir, "install.js");
const pathFile = path.join(electronDir, "path.txt");

function getPlatformPath() {
  switch (process.env.npm_config_platform ?? os.platform()) {
    case "mas":
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "freebsd":
    case "openbsd":
    case "linux":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error(`Electron builds are not available on platform: ${os.platform()}`);
  }
}

function getElectronExecutablePath(platformPath) {
  const distRoot = process.env.ELECTRON_OVERRIDE_DIST_PATH ?? path.join(electronDir, "dist");
  return path.join(distRoot, platformPath);
}

function isElectronReady() {
  if (!existsSync(installScript) || !existsSync(pathFile)) {
    return false;
  }

  const executablePath = readFileSync(pathFile, "utf-8").trim();
  if (!executablePath) {
    return false;
  }

  return existsSync(getElectronExecutablePath(executablePath));
}

function repairMissingPathFile() {
  const platformPath = getPlatformPath();
  if (!existsSync(getElectronExecutablePath(platformPath))) {
    return false;
  }

  writeFileSync(pathFile, platformPath);
  return true;
}

if (!isElectronReady()) {
  if (!repairMissingPathFile()) {
    console.log("[frame-view] Electron binary is missing; running electron/install.js");
    const result = spawnSync(process.execPath, [installScript], {
      cwd: electronDir,
      stdio: "inherit",
    });

    if (result.status !== 0) {
      console.error(
        [
          "[frame-view] Electron failed to install.",
          "Try:",
          "  rm -rf node_modules/electron",
          "  pnpm install",
        ].join("\n"),
      );
      process.exit(result.status ?? 1);
    }
  }
}
