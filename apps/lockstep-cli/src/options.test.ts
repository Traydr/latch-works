import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ConfigStore, createConfigStore } from "./config.js";
import { getMissingFields, type MissingField, parseArgv, resolveOptions } from "./options.js";
import type { CliOptions } from "./types.js";

describe("config persistence", () => {
  let tempDir: string;
  let archive: string;
  let store: ConfigStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "lockstep-config-"));
    archive = path.join(tempDir, "archive");
    store = createConfigStore({ configDir: path.join(tempDir, "config") });
  });

  afterEach(async () => {
    await rm(tempDir, { force: true, recursive: true });
  });

  /** Resolves argv and writes back what the run remembers, as `cli.ts` does. */
  async function run(argv: string[], env: NodeJS.ProcessEnv = {}): Promise<CliOptions> {
    const resolved = await resolveOptions(argv, { configStore: store, env, isInteractive: false });

    if (!resolved) {
      throw new Error("Expected a resolved run");
    }

    await store.remember(resolved.remember);

    return resolved.options;
  }

  it("remembers the source and API URL but not run flags", async () => {
    await run([
      "plan",
      "--source",
      archive,
      "--api-url",
      "http://localhost:3000",
      "--hash",
      "--show-skipped",
      "--max-changes",
      "5",
      "--upload-concurrency",
      "2",
    ]);

    expect(JSON.parse(await readFile(store.path, "utf-8"))).toEqual({
      apiUrl: "http://localhost:3000",
      source: archive,
    });

    const next = await run(["plan"]);
    expect(next).toMatchObject({ hashFiles: false, showSkipped: false, source: archive });
    expect(next.maxChanges).toBeUndefined();
    expect(next.uploadConcurrency).toBeUndefined();
  });

  it("applies hand-written defaults, lets flags override them, and never rewrites them", async () => {
    const defaults = `"defaults": { "hashFiles": true, "showSkipped": true, "maxChanges": 7 }`;
    const handWritten = `{ "source": ${JSON.stringify(archive)}, ${defaults}, "note": "mine" }\n`;
    await mkdir(path.dirname(store.path), { recursive: true });
    await writeFile(store.path, handWritten, "utf-8");

    expect(await run(["plan"])).toMatchObject({
      hashFiles: true,
      maxChanges: 7,
      showSkipped: true,
    });
    expect(
      await run(["plan", "--no-hash", "--no-show-skipped", "--source", archive]),
    ).toMatchObject({ hashFiles: false, showSkipped: false });
    expect(await readFile(store.path, "utf-8")).toBe(handWritten);
  });

  it("does not remember a source that came from the environment", async () => {
    await run(["plan"], { LOCKSTEP_SOURCE: archive });

    await expect(readFile(store.path, "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a value-less --source instead of pruning the saved source", async () => {
    await run(["plan", "--source", archive, "--api-url", "http://localhost:3000"]);

    await expect(run(["prune", "--yes", "--source"])).rejects.toThrow("--source requires a value.");
  });
});

describe("parseArgv", () => {
  it("parses push --upload-concurrency bounds", () => {
    const result = parseArgv(["push", "--source", "D:\\media", "--upload-concurrency", "3"]);
    expect(result.kind).toBe("parsed");

    if (result.kind !== "parsed") {
      return;
    }

    expect(result.options.uploadConcurrency).toBe(3);
  });

  it("rejects invalid --upload-concurrency values", () => {
    expect(() => parseArgv(["push", "--upload-concurrency", "0"])).toThrow(
      "--upload-concurrency must be an integer between 1 and 8.",
    );
    expect(() => parseArgv(["push", "--upload-concurrency", "9"])).toThrow(
      "--upload-concurrency must be an integer between 1 and 8.",
    );
    expect(() => parseArgv(["push", "--upload-concurrency", "1.5"])).toThrow(
      "--upload-concurrency must be an integer between 1 and 8.",
    );
  });
});

describe("parseArgv value flags", () => {
  const valueFlags = ["--source", "--api-url", "--api-token-env", "--remote-snapshot"];

  it.each(valueFlags)("rejects %s with no value, an empty value, or another flag", (flag) => {
    for (const command of ["plan", "push", "prune", "verify"]) {
      const message = `${flag} requires a value.`;
      expect(() => parseArgv([command, flag])).toThrow(message);
      expect(() => parseArgv([command, flag, ""])).toThrow(message);
      expect(() => parseArgv([command, flag, "--yes"])).toThrow(message);
    }
  });

  it("rejects numeric flags with no value", () => {
    expect(() => parseArgv(["prune", "--max-changes"])).toThrow("--max-changes");
    expect(() => parseArgv(["push", "--upload-concurrency"])).toThrow("--upload-concurrency");
  });
});

describe("getMissingFields", () => {
  const base: CliOptions = {
    apiTokenEnv: "LOCKSTEP_API_TOKEN",
    command: "plan",
    hashFiles: false,
    showSkipped: false,
    yes: false,
  };

  it("requires source for plan", () => {
    expect(getMissingFields(base)).toEqual<MissingField[]>(["source"]);
  });

  it("requires remote snapshot for verify", () => {
    expect(
      getMissingFields({
        ...base,
        command: "verify",
        source: "D:\\media",
      }),
    ).toEqual(["remoteSnapshot"]);
  });

  it("requires api URL for push when not in env", () => {
    expect(
      getMissingFields({
        ...base,
        command: "push",
        source: "D:\\media",
      }),
    ).toEqual(["apiUrl"]);
  });

  it("does not require push confirmation for scripted push", () => {
    expect(
      getMissingFields(
        {
          ...base,
          command: "push",
          source: "D:\\media",
          apiUrl: "http://localhost:3000",
        },
        {},
      ),
    ).toEqual([]);
  });
});
