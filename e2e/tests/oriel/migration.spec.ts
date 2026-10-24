import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { launchOriel, type OrielSession } from "../../src/oriel.ts";

let session: OrielSession | undefined;

test.afterEach(async () => {
  await session?.app.close();
  session = undefined;
});

const ReportSchema = z.object({ preferences: z.array(z.string()), windowState: z.boolean() });

/**
 * Builds the folders the old apps left: a Glazier and a Frame View `Local Storage` holding their
 * renderer preferences, and Frame View's settings with a saved window. The storage comes from a
 * real run, so its format is Chromium's own.
 */
async function oldAppFolders(): Promise<string> {
  session = await launchOriel();

  await session.window.evaluate(() => {
    localStorage.setItem("glazier.theme", "dark");
    localStorage.setItem("glazier.library.mode", "grid");
    localStorage.setItem("frameview.viewer.volume", "0.4");
  });

  const source = path.join(session.userDataDir, "Local Storage");

  await session.app.close();
  session = undefined;

  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "oriel-migration-"));

  for (const app of ["glazier", "frame-view"]) {
    await mkdir(path.join(userDataDir, app), { recursive: true });
    await cp(source, path.join(userDataDir, app, "Local Storage"), { recursive: true });
  }

  await writeFile(
    path.join(userDataDir, "frame-view", "frame-view-settings.json"),
    JSON.stringify({
      version: 3,
      settings: {},
      windowBounds: { x: 120, y: 90, width: 1100, height: 720 },
      windowMaximized: false,
    }),
  );

  return userDataDir;
}

test("the first start brings the old apps' preferences and window over", async () => {
  const userDataDir = await oldAppFolders();

  session = await launchOriel(userDataDir);
  const { app, window } = session;

  // Glazier's theme is Oriel's now; its own keys and Frame View's keep their names.
  await expect(window.locator("html")).toHaveClass(/\bdark\b/);
  expect(
    await window.evaluate(() => [
      localStorage.getItem("oriel.theme"),
      localStorage.getItem("glazier.library.mode"),
      localStorage.getItem("frameview.viewer.volume"),
    ]),
  ).toEqual(["dark", "grid", "0.4"]);

  const bounds = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((candidate) => candidate.webContents.getURL().endsWith("index.html"))
      ?.getBounds(),
  );

  expect(bounds).toMatchObject({ width: 1100, height: 720 });

  const report = ReportSchema.parse(
    JSON.parse(await readFile(path.join(userDataDir, "migration.json"), "utf8")),
  );

  expect(report.windowState).toBe(true);
  expect(report.preferences).toEqual(
    expect.arrayContaining(["oriel.theme", "glazier.library.mode", "frameview.viewer.volume"]),
  );
});
