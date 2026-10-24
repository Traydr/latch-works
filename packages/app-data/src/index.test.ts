import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type DataFolderApp, latchWorksHome, setLatchWorksDataFolder } from "./index.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "latch-works-home-"));
});

afterEach(async () => {
  await rm(home, { force: true, recursive: true });
});

/** Electron's `app` as far as the data folder goes, starting at `userData`. */
function fakeApp(userData: string, switches: readonly string[] = []) {
  const app: DataFolderApp & { userData: string } = {
    userData,
    getPath: () => app.userData,
    setPath: (_name, value) => {
      app.userData = value;
    },
    commandLine: { hasSwitch: (name) => switches.includes(name) },
  };

  return app;
}

describe("the shared data folder", () => {
  it("moves an app's old data folder under ~/.latch-works, once", async () => {
    const legacy = path.join(home, "Library", "Application Support", "Glazier");
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, "catalog.sqlite"), "catalog");

    const app = fakeApp(legacy);
    const target = path.join(latchWorksHome(home), "glazier");

    expect(setLatchWorksDataFolder(app, { folder: "glazier", home })).toBe(target);
    expect(app.userData).toBe(target);
    expect(await readFile(path.join(target, "catalog.sqlite"), "utf8")).toBe("catalog");

    // A later start finds it already there, and leaves a folder recreated at the old place alone.
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, "stray"), "stray");

    expect(setLatchWorksDataFolder(fakeApp(legacy), { folder: "glazier", home })).toBe(target);
    expect(await readFile(path.join(legacy, "stray"), "utf8")).toBe("stray");
  });

  it("starts fresh under ~/.latch-works when there was nothing before", () => {
    const app = fakeApp(path.join(home, "Library", "Application Support", "Frame View"));

    expect(setLatchWorksDataFolder(app, { folder: "frame-view", home })).toBe(
      path.join(home, ".latch-works", "frame-view"),
    );
  });

  it("keeps a folder chosen with --user-data-dir", () => {
    const chosen = path.join(home, "e2e-run");
    const app = fakeApp(chosen, ["user-data-dir"]);

    expect(setLatchWorksDataFolder(app, { folder: "lockstep", home })).toBe(chosen);
    expect(app.userData).toBe(chosen);
  });
});
