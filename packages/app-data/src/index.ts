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
  getPath(name: "userData" | "appData"): string;
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

  if (!moveFolderInto(current, target)) {
    return current;
  }

  app.setPath("userData", target);

  return target;
}

/**
 * Moves `from` to `to` whole, the first time: nothing happens once `to` exists or when there is
 * nothing at `from`. False only when the move was tried and failed.
 */
function moveFolderInto(from: string, to: string): boolean {
  if (path.resolve(from) === path.resolve(to) || !existsSync(from) || existsSync(to)) {
    return true;
  }

  try {
    mkdirSync(path.dirname(to), { recursive: true });
    renameSync(from, to);

    return true;
  } catch {
    return false;
  }
}

export interface ModeFolderOptions {
  /** The standalone app's folder under `~/.latch-works`, such as `glazier`. */
  folder: string;
  /** The standalone app's product name, which named its folder before `~/.latch-works`. */
  legacyName: string;
  /** For tests: the home folder to put `.latch-works` in. */
  home?: string;
}

/**
 * The data folder of one of Oriel's modes: the one its standalone app used,
 * `~/.latch-works/<folder>`, so catalogs, settings and caches carry on where they are. An app
 * that never ran after the move to `~/.latch-works` still has its folder at `<appData>/<App>`
 * (`~/Library/Application Support/Glazier` and the like), which is moved in first; if that move
 * fails, the mode keeps the old folder. Under `--user-data-dir` (tests) the mode's folder sits
 * inside that directory. Call it after {@link setLatchWorksDataFolder}. Returns the folder, which
 * exists afterwards.
 */
export function latchWorksModeFolder(app: DataFolderApp, options: ModeFolderOptions): string {
  if (app.commandLine.hasSwitch("user-data-dir")) {
    const nested = path.join(app.getPath("userData"), options.folder);

    mkdirSync(nested, { recursive: true });

    return nested;
  }

  const target = path.join(latchWorksHome(options.home), options.folder);
  const legacy = path.join(app.getPath("appData"), options.legacyName);

  if (!moveFolderInto(legacy, target)) {
    return legacy;
  }

  mkdirSync(target, { recursive: true });

  return target;
}
