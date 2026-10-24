import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { app, dialog } from "electron";

import type { MigrationReport } from "./migration";

const WELCOMED_FILE = "welcomed";

const MOVE_DECLINED_FILE = "move-to-applications-declined";

/** Whether the owner has been through the welcome, which shows once. */
export function welcomed(orielDir: string): boolean {
  return existsSync(path.join(orielDir, WELCOMED_FILE));
}

export function markWelcomed(orielDir: string): void {
  writeFileSync(path.join(orielDir, WELCOMED_FILE), `${new Date().toISOString()}\n`);
}

function count(value: number, one: string, many: string): string {
  return `${value.toLocaleString()} ${value === 1 ? one : many}`;
}

/** The first start's migration in one line for the welcome, or null when nothing came over. */
export function describeMigration(report: MigrationReport | null): string | null {
  if (!report) {
    return null;
  }

  const parts = [
    report.folders.length > 0 ? count(report.folders.length, "folder", "folders") : null,
    report.tokens.migrated > 0
      ? count(report.tokens.migrated, "saved sync token", "saved sync tokens")
      : null,
    report.preferences.length > 0 ? "your preferences" : null,
    report.windowState ? "the window's size" : null,
  ].filter((part) => part !== null);

  if (parts.length === 0) {
    return null;
  }

  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];

  return `Brought over ${list} from Frame View, Glazier and Lockstep${
    report.removed.length > 0 ? ", and removed the old apps" : ""
  }.`;
}

/**
 * On macOS, offers to move an Oriel started outside Applications (from the disk image, or
 * Downloads) into it, unless the owner said not to ask again. Resolves true when the app moves,
 * since it then quits and starts again from Applications.
 */
export async function offerMoveToApplications(orielDir: string): Promise<boolean> {
  const declined = path.join(orielDir, MOVE_DECLINED_FILE);

  if (
    process.platform !== "darwin" ||
    !app.isPackaged ||
    app.isInApplicationsFolder() ||
    existsSync(declined)
  ) {
    return false;
  }

  const { response, checkboxChecked } = await dialog.showMessageBox({
    type: "question",
    message: "Move Oriel to Applications?",
    detail:
      "It runs from where it is, but from Applications it stays when the disk image is ejected or Downloads is cleared out.",
    buttons: ["Move to Applications", "Not Now"],
    defaultId: 0,
    cancelId: 1,
    checkboxLabel: "Don't ask again",
  });

  if (response !== 0) {
    if (checkboxChecked) {
      writeFileSync(declined, `${new Date().toISOString()}\n`);
    }

    return false;
  }

  try {
    return app.moveToApplicationsFolder({
      conflictHandler: (conflict) =>
        conflict === "exists" &&
        dialog.showMessageBoxSync({
          type: "question",
          message: "Replace the Oriel in Applications?",
          detail: "An older copy is there. Your folders, catalogs and settings are not touched.",
          buttons: ["Replace", "Cancel"],
          defaultId: 0,
          cancelId: 1,
        }) === 0,
    });
  } catch (cause) {
    dialog.showErrorBox(
      "Oriel could not move to Applications",
      cause instanceof Error ? cause.message : String(cause),
    );

    return false;
  }
}
