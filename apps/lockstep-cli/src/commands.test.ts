import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import type { LockstepPlan } from "@latch-works/lockstep-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type CoreCommands, executeCommand } from "./commands.js";
import type { CliOptions } from "./types.js";

const planSync = vi.fn();

const pruneDeleted = vi.fn();

const pushChanges = vi.fn();

const runDoctorCore = vi.fn();

const core: CoreCommands = {
  doctor: runDoctorCore,
  planSync,
  pruneDeleted,
  pushChanges,
};

function createPlan(overrides: Partial<LockstepPlan> = {}): LockstepPlan {
  return {
    counts: { delete: 0, keep: 0, update: 0, upload: 0 },
    items: [],
    skipped: 0,
    skippedEntries: [],
    sourceRoot: "/tmp/archive",
    totalBytes: 0,
    totalFiles: 0,
    ...overrides,
  };
}

function createPruneOptions(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    apiTokenEnv: "LOCKSTEP_API_TOKEN",
    apiUrl: "http://localhost:3000",
    command: "prune",
    hashFiles: false,
    showSkipped: false,
    source: "/tmp/archive",
    yes: false,
    ...overrides,
  };
}

describe("executeCommand prune", () => {
  const originalEnv = process.env;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.env = {
      ...originalEnv,
      LOCKSTEP_API_TOKEN: "test-token",
    };
    planSync.mockReset();
    pruneDeleted.mockReset();
    pushChanges.mockReset();
    runDoctorCore.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it("does not call pruneDeleted without --yes in non-interactive mode", async () => {
    planSync.mockResolvedValue(
      createPlan({
        counts: { delete: 1, keep: 0, update: 0, upload: 0 },
        items: [{ action: "delete", path: "old.jpg" }],
      }),
    );

    await executeCommand(createPruneOptions(), {
      core,
      isInteractive: () => false,
    });

    expect(pruneDeleted).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("uses remote-aware hashing for push planning", async () => {
    const plan = createPlan();
    planSync.mockResolvedValue(plan);
    pushChanges.mockResolvedValue({ failed: 0, plan, pushed: 0 });

    await executeCommand(createPruneOptions({ command: "push" }), { core });

    expect(planSync).toHaveBeenCalledWith(
      expect.objectContaining({ hashMode: "remote-aware" }),
      expect.anything(),
    );
    expect(pushChanges).toHaveBeenCalledOnce();
  });

  it("prunes the plan it printed with --yes, without planning again", async () => {
    const printedPlan = createPlan({
      counts: { delete: 1, keep: 0, update: 0, upload: 0 },
      items: [{ action: "delete", path: "old.jpg" }],
    });

    planSync.mockResolvedValue(printedPlan);
    pruneDeleted.mockResolvedValue({ failed: 0, plan: printedPlan, pruned: 1, skipped: 0 });

    await executeCommand(createPruneOptions({ maxChanges: 5, yes: true }), {
      core,
      isInteractive: () => false,
    });

    expect(planSync).toHaveBeenCalledOnce();
    expect(pruneDeleted).toHaveBeenCalledWith(
      expect.objectContaining({ maxChanges: 1, plan: printedPlan }),
      expect.anything(),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("prints every delete it applies before confirming, however many there are", async () => {
    const paths = Array.from({ length: 30 }, (_, index) => `old-${index}.jpg`);

    const plan = createPlan({
      counts: { delete: paths.length, keep: 0, update: 0, upload: 0 },
      items: paths.map((entry) => ({ action: "delete" as const, path: entry })),
    });

    const printed: string[] = [];
    vi.mocked(console.log).mockImplementation((line: string) => printed.push(line));
    planSync.mockResolvedValue(plan);
    pruneDeleted.mockResolvedValue({ failed: 0, plan, pruned: 25, skipped: 0 });
    const confirmPrune = vi.fn().mockResolvedValue(true);

    await executeCommand(createPruneOptions({ maxChanges: 25 }), {
      confirmPrune,
      core,
      isInteractive: () => true,
    });

    const listed = printed.filter((line) => line.startsWith("  delete "));
    expect(listed).toEqual(paths.slice(0, 25).map((entry) => `  delete ${entry}`));
    expect(confirmPrune).toHaveBeenCalledExactlyOnceWith(25);
    expect(pruneDeleted).toHaveBeenCalledWith(
      expect.objectContaining({ maxChanges: 25, plan }),
      expect.anything(),
    );
  });

  it("does not prompt or call pruneDeleted when there are zero deletes", async () => {
    planSync.mockResolvedValue(createPlan());
    const confirmPrune = vi.fn();

    await executeCommand(createPruneOptions(), {
      confirmPrune,
      core,
      isInteractive: () => true,
    });

    expect(confirmPrune).not.toHaveBeenCalled();
    expect(pruneDeleted).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("requires interactive confirmation when --yes is absent", async () => {
    planSync.mockResolvedValue(
      createPlan({
        counts: { delete: 1, keep: 0, update: 0, upload: 0 },
        items: [{ action: "delete", path: "old.jpg" }],
      }),
    );
    pruneDeleted.mockResolvedValue({ failed: 0, plan: createPlan(), pruned: 1, skipped: 0 });
    const confirmPrune = vi.fn().mockResolvedValue(true);

    await executeCommand(createPruneOptions(), {
      confirmPrune,
      core,
      isInteractive: () => true,
    });

    expect(confirmPrune).toHaveBeenCalledExactlyOnceWith(1);
    expect(pruneDeleted).toHaveBeenCalledOnce();
  });

  it("exits non-zero when interactive confirmation is declined", async () => {
    planSync.mockResolvedValue(
      createPlan({
        counts: { delete: 1, keep: 0, update: 0, upload: 0 },
        items: [{ action: "delete", path: "old.jpg" }],
      }),
    );
    const confirmPrune = vi.fn().mockResolvedValue(false);

    await executeCommand(createPruneOptions(), {
      confirmPrune,
      core,
      isInteractive: () => true,
    });

    expect(pruneDeleted).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

/** `Server.address()` widens to a pipe name or null; only a bound TCP address is usable. */
const TcpAddressSchema = z.object({ port: z.number() });

describe("executeCommand cancellation", () => {
  const originalEnv = process.env;
  let archive: string;
  let server: Server;
  let apiUrl: string;
  let finalized: unknown[];
  const controller = { current: new AbortController() };

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.env = { ...originalEnv, LOCKSTEP_API_TOKEN: "test-token" };
    archive = await mkdtemp(path.join(os.tmpdir(), "lockstep-cancel-"));
    await writeFile(path.join(archive, "new.jpg"), "new");
    finalized = [];
    controller.current = new AbortController();

    // A Pane View stand-in whose first item request never answers until the run is aborted.
    server = createServer(async (request, response) => {
      let body = "";

      for await (const chunk of request) {
        body += chunk;
      }

      const respond = (json: string) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(json);
      };

      if (request.url === "/api/sync/snapshot") {
        respond('{"entries":[{"path":"gone.jpg","size":3}]}');
      } else if (request.url === "/api/sync/runs") {
        respond('{"syncRunId":"run-1"}');
      } else if (request.url === "/api/sync/runs/run-1/complete") {
        finalized.push(JSON.parse(body));
        respond('{"ok":true}');
      } else {
        controller.current.abort(new Error("Cancelled by SIGINT."));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiUrl = `http://127.0.0.1:${TcpAddressSchema.parse(server.address()).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(archive, { force: true, recursive: true });
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it.each(["push", "prune"] as const)("finalizes the %s run as cancelled", async (command) => {
    const run = executeCommand(
      createPruneOptions({ apiUrl, command, source: archive, yes: true }),
      { signal: controller.current.signal },
    );

    await expect(run).rejects.toThrow("Cancelled by SIGINT.");
    expect(finalized).toEqual([expect.objectContaining({ status: "cancelled" })]);
  });
});
