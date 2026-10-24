import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { app, BrowserWindow, dialog, session } from "electron";
import { z } from "zod";

import { oldInstalls, removeOldInstall, runningOldApps } from "./old-apps";
import { readWindowState, type WindowState, writeWindowState } from "./window-state";

/** What the first start brought over from the old apps, kept in `migration.json`. */
const MigrationReportSchema = z.object({
  ranAt: z.string(),
  tokens: z.object({ migrated: z.number(), failed: z.number() }),
  preferences: z.array(z.string()),
  windowState: z.boolean(),
  folders: z.array(z.string()),
  removed: z.array(z.string()),
});

export type MigrationReport = z.infer<typeof MigrationReportSchema>;

const REPORT_FILE = "migration.json";

/** The old apps' folders, which are now Oriel's modes' folders, and Oriel's own. */
export interface MigrationFolders {
  oriel: string;
  frameView: string;
  glazier: string;
  lockstep: string;
}

/** What the modes hold that a migration reads or re-saves. */
export interface MigrationSources {
  /** View's saved window, Frame View's theme and its remembered folder. */
  view: {
    savedWindow(): WindowState | null;
    theme(): "system" | "light" | "dark";
    lastFolder(): string | null;
  };
  /** Sync's tokens and profiles. */
  sync: {
    unreadableTokens(): number;
    migrateLegacyTokens(): Promise<{ migrated: number; failed: number }>;
    sourceRoots(): string[];
  };
}

export function readMigrationReport(orielDir: string): MigrationReport | null {
  try {
    const parsed = MigrationReportSchema.safeParse(
      JSON.parse(readFileSync(path.join(orielDir, REPORT_FILE), "utf8")),
    );

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Waits until none of the old apps runs, asking the owner to quit them: Oriel opens the same
 * catalogs and settings. Resolves false when the owner would rather quit Oriel.
 */
export async function waitForOldAppsToQuit(): Promise<boolean> {
  for (;;) {
    const running = await runningOldApps();

    if (running.length === 0) {
      return true;
    }

    const { response } = await dialog.showMessageBox({
      type: "warning",
      message: `Quit ${running.join(" and ")} to continue`,
      detail:
        "Oriel opens the same catalogs, settings and profiles, which two apps must not change at once.",
      buttons: ["Try Again", "Quit Oriel"],
      defaultId: 0,
      cancelId: 1,
    });

    if (response === 1) {
      return false;
    }
  }
}

const StoredEntriesSchema = z.array(z.tuple([z.string(), z.string()]));

/** An empty page on the `file://` origin, which every packaged app's `localStorage` belongs to. */
function blankPage(folder: string): string {
  const page = path.join(folder, "blank.html");

  writeFileSync(page, "<!doctype html><title></title>");

  return page;
}

/** A temporary folder, removed when Oriel quits: a session keeps using its folder until then. */
function temporaryFolder(): string {
  const folder = mkdtempSync(path.join(os.tmpdir(), "oriel-storage-"));

  app.once("will-quit", () => rmSync(folder, { recursive: true, force: true }));

  return folder;
}

/**
 * Reads an old app's renderer `localStorage`, from a copy of its `Local Storage` folder so the
 * original is never opened, under a session of its own.
 */
async function readOldStorage(appDir: string): Promise<[string, string][]> {
  const source = path.join(appDir, "Local Storage");

  if (!existsSync(source)) {
    return [];
  }

  const copy = temporaryFolder();

  try {
    cpSync(source, path.join(copy, "Local Storage"), { recursive: true });

    const reader = new BrowserWindow({
      show: false,
      webPreferences: { session: session.fromPath(copy), sandbox: true, contextIsolation: true },
    });

    try {
      await reader.loadFile(blankPage(copy));

      return StoredEntriesSchema.parse(
        await reader.webContents.executeJavaScript("Object.entries(localStorage)"),
      );
    } finally {
      reader.destroy();
    }
  } catch (error) {
    console.warn(
      `[oriel:migration] ${appDir}: ${error instanceof Error ? error.message : String(error)}`,
    );

    return [];
  }
}

/** Sets each key Oriel's window does not have yet; returns the keys it set. */
async function writeOrielStorage(entries: [string, string][]): Promise<string[]> {
  if (entries.length === 0) {
    return [];
  }

  const folder = temporaryFolder();
  const writer = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });

  try {
    await writer.loadFile(blankPage(folder));

    const written = await writer.webContents.executeJavaScript(
      `(${JSON.stringify(entries)}).filter(([key, value]) => {
        if (localStorage.getItem(key) !== null) return false;
        localStorage.setItem(key, value);
        return true;
      }).map(([key]) => key)`,
    );

    return z.array(z.string()).parse(written);
  } finally {
    writer.destroy();
  }
}

/**
 * The old apps' renderer preferences, under the keys Oriel reads. Glazier's keys keep their
 * names (Tidy reads them as they are) except its theme and sidebar, which are Oriel's now; Frame
 * View's video volume keeps its own. The theme is Glazier's if it had one, else Frame View's.
 */
async function preferences(
  folders: MigrationFolders,
  frameViewTheme: string,
): Promise<[string, string][]> {
  const glazier = await readOldStorage(folders.glazier);
  const frameView = await readOldStorage(folders.frameView);

  const renamed = new Map([
    ["glazier.theme", "oriel.theme"],
    ["glazier.sidebar.narrow", "oriel.sidebar.narrow"],
    ["glazier.sidebar.wide", "oriel.sidebar.wide"],
  ]);

  const entries: [string, string][] = [];

  for (const [key, value] of glazier) {
    if (key.startsWith("glazier.")) {
      entries.push([renamed.get(key) ?? key, value]);
    }
  }

  for (const [key, value] of frameView) {
    if (key.startsWith("frameview.")) {
      entries.push([key, value]);
    }
  }

  if (!entries.some(([key]) => key === "oriel.theme") && frameViewTheme !== "system") {
    entries.push(["oriel.theme", frameViewTheme]);
  }

  return entries;
}

const RootPathRowSchema = z.object({ path: z.string() });

/** The folders Glazier tidies, read from its catalog without starting the engine. */
function glazierRoots(glazierDir: string): string[] {
  const file = path.join(glazierDir, "catalog.sqlite");

  if (!existsSync(file)) {
    return [];
  }

  try {
    const db = new DatabaseSync(file, { readOnly: true });

    try {
      return db
        .prepare("SELECT path FROM roots ORDER BY id")
        .all()
        .map((row) => RootPathRowSchema.parse(row).path);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * Removes the old apps after one confirmation that says what came along. Returns where they were.
 */
async function offerToRemoveOldApps(report: Omit<MigrationReport, "removed">): Promise<string[]> {
  const installs = oldInstalls();

  if (installs.length === 0) {
    return [];
  }

  const names = [...new Set(installs.map((install) => install.name))];
  const unread = report.tokens.failed;

  const tokensLine =
    unread === 0
      ? ""
      : ` Sync could not read ${unread === 1 ? "one saved token" : `${unread} saved tokens`} and asks for ${unread === 1 ? "it" : "them"} again.`;

  const { response } = await dialog.showMessageBox({
    type: "question",
    message: `Remove ${names.join(", ").replace(/, ([^,]*)$/, " and $1")}?`,
    detail: `Oriel now does what they did, with their folders, catalogs, settings and sync profiles.${tokensLine} ${
      process.platform === "darwin"
        ? "They go to the Trash."
        : "They are uninstalled, with their shortcuts."
    }`,
    buttons: ["Remove", "Keep Them"],
    defaultId: 0,
    cancelId: 1,
  });

  if (response !== 0) {
    return [];
  }

  const removed: string[] = [];

  for (const install of installs) {
    if (await removeOldInstall(install)) {
      removed.push(install.location);
    }
  }

  return removed;
}

/**
 * Brings the old apps' data into Oriel, once, before its window opens; the File menu runs it
 * again. Catalogs, caches and settings are already in their folders. This re-saves the sync tokens
 * the old Lockstep app encrypted, carries over renderer preferences and the window's size, lists
 * every folder the old apps knew, and offers to remove the old apps. A value Oriel already has is
 * never overwritten.
 */
export async function migrateOldApps(
  folders: MigrationFolders,
  sources: MigrationSources,
  { offerRemoval }: { offerRemoval: boolean },
): Promise<MigrationReport> {
  const tokens =
    sources.sync.unreadableTokens() > 0
      ? await sources.sync.migrateLegacyTokens()
      : { migrated: 0, failed: 0 };

  const preferenceKeys = await writeOrielStorage(await preferences(folders, sources.view.theme()));

  const savedWindow = sources.view.savedWindow();
  const windowState = savedWindow !== null && readWindowState(folders.oriel) === null;

  if (windowState) {
    writeWindowState(folders.oriel, savedWindow);
  }

  const lastFolder = sources.view.lastFolder();

  const folderList = [
    ...new Set([
      ...(lastFolder ? [lastFolder] : []),
      ...glazierRoots(folders.glazier),
      ...sources.sync.sourceRoots(),
    ]),
  ];

  const partial = {
    ranAt: new Date().toISOString(),
    tokens,
    preferences: preferenceKeys,
    windowState,
    folders: folderList,
  };

  const report: MigrationReport = {
    ...partial,
    removed: offerRemoval ? await offerToRemoveOldApps(partial) : [],
  };

  writeFileSync(path.join(folders.oriel, REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`);

  return report;
}
