import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { shell } from "electron";

/** The three standalone apps Oriel replaces. */
const OLD_APPS = [
  { name: "Frame View", executable: "frame-view", squirrel: "frame-view" },
  { name: "Glazier", executable: "glazier", squirrel: "glazier" },
  { name: "Lockstep", executable: "lockstep", squirrel: "lockstep" },
] as const;

type OldAppName = (typeof OLD_APPS)[number]["name"];

/** An installed copy of an old app, and how to remove it. */
export interface OldInstall {
  name: OldAppName;
  /** The `.app` bundle on macOS; the Squirrel folder holding `Update.exe` on Windows. */
  location: string;
}

function output(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

/**
 * The old apps that are running now. Oriel must not open their catalogs and settings while they
 * do: two Glazier engines on one catalog is the one thing here that can lose work.
 */
export async function runningOldApps(): Promise<OldAppName[]> {
  switch (process.platform) {
    case "darwin": {
      const commands = await output("ps", ["-A", "-o", "comm="]);

      return OLD_APPS.flatMap(({ name }) =>
        commands.includes(`/${name}.app/Contents/MacOS/`) ? [name] : [],
      );
    }

    case "win32": {
      const tasks = (await output("tasklist", ["/fo", "csv", "/nh"])).toLowerCase();

      return OLD_APPS.flatMap(({ name, executable }) =>
        tasks.includes(`"${executable}.exe"`) ? [name] : [],
      );
    }

    default:
      return [];
  }
}

/**
 * Where the old apps are installed: their bundles in `/Applications` or `~/Applications` on macOS,
 * and their Squirrel installs under `%LOCALAPPDATA%` on Windows. Nothing else is ever offered for
 * removal, so a build in the repository's `out/` folders is never touched.
 */
export function oldInstalls(): OldInstall[] {
  switch (process.platform) {
    case "darwin": {
      const folders = ["/Applications", path.join(os.homedir(), "Applications")];

      return OLD_APPS.flatMap(({ name }) =>
        folders.flatMap((folder) => {
          const location = path.join(folder, `${name}.app`);

          return existsSync(location) ? [{ name, location }] : [];
        }),
      );
    }

    case "win32": {
      const localAppData = process.env.LOCALAPPDATA;

      if (!localAppData) {
        return [];
      }

      return OLD_APPS.flatMap(({ name, squirrel }) => {
        const location = path.join(localAppData, squirrel);

        return existsSync(path.join(location, "Update.exe")) ? [{ name, location }] : [];
      });
    }

    default:
      return [];
  }
}

/**
 * Removes one old install: a macOS bundle goes to the Trash, and a Windows install is uninstalled
 * by its own Squirrel `Update.exe`, which also removes its Start-menu shortcuts.
 */
export async function removeOldInstall(install: OldInstall): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      return await new Promise((resolve) => {
        const child = spawn(path.join(install.location, "Update.exe"), ["--uninstall"], {
          stdio: "ignore",
        });

        child.on("error", () => resolve(false));
        child.on("close", (code) => resolve(code === 0));
      });
    }

    await shell.trashItem(install.location);

    return true;
  } catch {
    return false;
  }
}
