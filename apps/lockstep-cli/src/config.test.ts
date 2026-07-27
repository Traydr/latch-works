import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfigStore, parseConfig } from "./config.js";

const tempDirs: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempConfigDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lockstep-config-"));
  tempDirs.push(dir);
  return dir;
}

describe("parseConfig", () => {
  it("parses known fields, ignores unknown keys, and empties invalid input", () => {
    expect(parseConfig(null)).toEqual({});
    expect(parseConfig("nope")).toEqual({});
    expect(
      parseConfig({
        source: "T:\\media",
        apiUrl: "https://example.test",
        lastCommand: "plan",
        extra: true,
        defaults: {
          hashFiles: true,
          maxChanges: 10,
          showSkipped: false,
          unknown: 1,
        },
      }),
    ).toEqual({
      source: "T:\\media",
      apiUrl: "https://example.test",
      lastCommand: "plan",
      defaults: {
        hashFiles: true,
        maxChanges: 10,
        showSkipped: false,
      },
    });
  });
});

describe("createConfigStore", () => {
  it("round-trips config through save and load", async () => {
    const configDir = await createTempConfigDir();
    const store = createConfigStore({ configDir });

    await store.save({
      source: "D:\\archive",
      apiUrl: "http://localhost:3000",
      lastCommand: "push",
      defaults: { maxChanges: 25 },
    });

    await expect(store.load()).resolves.toEqual({
      source: "D:\\archive",
      apiUrl: "http://localhost:3000",
      lastCommand: "push",
      defaults: { maxChanges: 25 },
    });

    const raw = await readFile(store.path, "utf-8");
    expect(JSON.parse(raw)).toMatchObject({
      source: "D:\\archive",
      lastCommand: "push",
    });
  });

  it("merges partial saves with existing config", async () => {
    const configDir = await createTempConfigDir();
    const store = createConfigStore({ configDir });

    await store.save({ source: "D:\\archive", defaults: { hashFiles: true } });
    await store.save({ apiUrl: "https://pane-view.test", defaults: { maxChanges: 5 } });

    await expect(store.load()).resolves.toEqual({
      source: "D:\\archive",
      apiUrl: "https://pane-view.test",
      defaults: {
        hashFiles: true,
        maxChanges: 5,
      },
    });
  });
});
