import { existsSync, mkdirSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { LATCH_WORKS_DIRECTORY_NAME } from "@latch-works/media-domain";

/**
 * The one folder every Latch Works app keeps its own data in, `~/.latch-works`, with a folder per
 * app under it (`glazier`, `frame-view`, `lockstep`) beside the shared ones (`hash-cache`, the
 * Lockstep CLI's config).
 */
export function latchWorksHome(home: string = os.homedir()): string {
  return path.join(home, LATCH_WORKS_DIRECTORY_NAME);
}

/** The part of Electron's `app` that choosing the data folder needs. */
export interface DataFolderApp {
  getPath(name: "userData"): string;
  setPath(name: "userData", value: string): void;
  commandLine: { hasSwitch(name: string): boolean };
}

export interface DataFolderOptions {
  /** The app's folder under `~/.latch-works`, such as `glazier`. */
  folder: string;
  /** For tests: the home folder to put `.latch-works` in. */
  home?: string;
}

/**
 * Points an Electron app's data folder (`userData`) at `~/.latch-works/<folder>`, and the first
 * time moves the folder it used before (`~/Library/Application Support/<App>` and the like) there
 * whole, so settings, catalogs and caches come along. An explicit `--user-data-dir` (tests, a
 * second profile) is left alone. If the move fails, the app keeps its old folder rather than
 * starting empty. Call it before the app is ready. Returns the folder in use.
 */
export function setLatchWorksDataFolder(app: DataFolderApp, options: DataFolderOptions): string {
  const current = app.getPath("userData");

  if (app.commandLine.hasSwitch("user-data-dir")) {
    return current;
  }

  const target = path.join(latchWorksHome(options.home), options.folder);

  if (
    path.resolve(current) !== path.resolve(target) &&
    existsSync(current) &&
    !existsSync(target)
  ) {
    try {
      mkdirSync(path.dirname(target), { recursive: true });
      renameSync(current, target);
    } catch {
      return current;
    }
  }

  app.setPath("userData", target);

  return target;
}
