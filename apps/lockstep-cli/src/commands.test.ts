import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type FakePaneView, startFakePaneView } from "@latch-works/lockstep-core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeCommand } from "./commands.js";
import type { RemoteRunOptions } from "./types.js";

/** A run against a fake Pane View, with the real lockstep-core and a source folder on disk. */
describe("executeCommand", () => {
  const originalEnv = process.env;
  let originalExitCode: typeof process.exitCode;
  let archive: string;
  let home: string;
  let paneView: FakePaneView;
  let printed: string[];

  function options(overrides: Partial<RemoteRunOptions>): RemoteRunOptions {
    return {
      apiToken: paneView.apiToken,
      apiTokenEnv: "LOCKSTEP_API_TOKEN",
      apiUrl: paneView.apiUrl,
      command: "prune",
      hashFiles: false,
      showSkipped: false,
      source: archive,
      yes: false,
      ...overrides,
    };
  }

  /** Pane View holds these paths, none of which is in the source folder. */
  async function serveRemote(paths: string[]): Promise<void> {
    paneView = await startFakePaneView({
      entries: paths.map((entryPath) => ({ path: entryPath, size: 1 })),
    });
  }

  function remaining(): string[] {
    return [...paneView.library.keys()].sort();
  }

  /** Answers the prune prompt with `answer` and records the count each prompt named. */
  function promptAnswering(answer: boolean) {
    const counts: number[] = [];

    return {
      confirmPrune: async (deleteCount: number) => {
        counts.push(deleteCount);

        return answer;
      },
      counts,
    };
  }

  beforeEach(async () => {
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    archive = await mkdtemp(path.join(os.tmpdir(), "lockstep-archive-"));
    home = await mkdtemp(path.join(os.tmpdir(), "lockstep-home-"));
    // The hash cache lives under the home folder.
    process.env = { ...originalEnv, HOME: home };
    printed = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      printed.push(line);
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    await paneView.close();
    await rm(archive, { force: true, recursive: true });
    await rm(home, { force: true, recursive: true });
    process.env = originalEnv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it("refuses to prune without --yes in non-interactive mode", async () => {
    await serveRemote(["old.jpg"]);

    await executeCommand(options({}), { isInteractive: () => false });

    expect(remaining()).toEqual(["old.jpg"]);
    expect(paneView.runs).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it("pushes a file whose content changed at the same size", async () => {
    paneView = await startFakePaneView({
      entries: [
        {
          path: "a.jpg",
          sha256: createHash("sha256").update("old!").digest("hex"),
          size: 4,
        },
      ],
    });
    await writeFile(path.join(archive, "a.jpg"), "new!");

    await executeCommand(options({ command: "push" }));

    expect(paneView.library.get("a.jpg")?.sha256).toBe(
      createHash("sha256").update("new!").digest("hex"),
    );
    expect(printed).toContain("Push finished: 1 change(s) applied.");
  });

  it("prunes with --yes exactly the deletes it printed, capped by --max-changes", async () => {
    await serveRemote(["gone-1.jpg", "gone-2.jpg", "gone-3.jpg"]);

    await executeCommand(options({ maxChanges: 2, yes: true }), { isInteractive: () => false });

    expect(printed.filter((line) => line.startsWith("  delete "))).toEqual([
      "  delete gone-1.jpg",
      "  delete gone-2.jpg",
    ]);
    expect(remaining()).toEqual(["gone-3.jpg"]);
    expect(process.exitCode).toBeUndefined();
  });

  it("lists every delete it asks about, however many there are", async () => {
    const paths = Array.from({ length: 30 }, (_, index) => `old-${index}.jpg`);
    await serveRemote(paths);
    const prompt = promptAnswering(true);

    await executeCommand(options({ maxChanges: 25 }), {
      confirmPrune: prompt.confirmPrune,
      isInteractive: () => true,
    });

    // The plan lists deletes in natural order, which is the order they were made in here.
    expect(printed.filter((line) => line.startsWith("  delete "))).toEqual(
      paths.slice(0, 25).map((entry) => `  delete ${entry}`),
    );
    expect(prompt.counts).toEqual([25]);
    expect(remaining()).toEqual(paths.slice(25).sort());
  });

  it("neither asks nor creates a run when there is nothing to prune", async () => {
    await serveRemote([]);
    const prompt = promptAnswering(true);

    await executeCommand(options({}), {
      confirmPrune: prompt.confirmPrune,
      isInteractive: () => true,
    });

    expect(prompt.counts).toEqual([]);
    expect(paneView.runs).toEqual([]);
    expect(printed).toContain("Nothing to prune.");
    expect(process.exitCode).toBeUndefined();
  });

  it("prunes once the prompt is confirmed", async () => {
    await serveRemote(["old.jpg"]);
    const prompt = promptAnswering(true);

    await executeCommand(options({}), {
      confirmPrune: prompt.confirmPrune,
      isInteractive: () => true,
    });

    expect(prompt.counts).toEqual([1]);
    expect(remaining()).toEqual([]);
  });

  it("prunes nothing and exits non-zero when the prompt is declined", async () => {
    await serveRemote(["old.jpg"]);
    const prompt = promptAnswering(false);

    await executeCommand(options({}), {
      confirmPrune: prompt.confirmPrune,
      isInteractive: () => true,
    });

    expect(remaining()).toEqual(["old.jpg"]);
    expect(paneView.runs).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it.each(["push", "prune"] as const)("finalizes the %s run as cancelled", async (command) => {
    await serveRemote(["gone.jpg"]);
    await writeFile(path.join(archive, "new.jpg"), "new");
    const controller = new AbortController();

    // The first item's request is never answered; the interrupt arrives while it waits.
    paneView.intercept((request) => {
      if (request.route !== "uploadUrl" && request.route !== "delete") return undefined;
      controller.abort(new Error("Cancelled by SIGINT."));

      return "hold";
    });

    const run = executeCommand(options({ command, yes: true }), { signal: controller.signal });

    await expect(run).rejects.toThrow("Cancelled by SIGINT.");
    expect(paneView.runs.map((syncRun) => syncRun.outcome?.status)).toEqual(["cancelled"]);
  });
});
